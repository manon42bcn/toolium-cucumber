"""Find Behave step definitions without importing project Python modules."""

import ast
from collections import namedtuple
from functools import lru_cache
import json
from io import StringIO
import os
from pathlib import Path
import re
import site
from string import Formatter
import sys
import sysconfig
import tokenize

DECORATOR_MODULES = {
    'behave', 'behave.step_registry', 'toolium.behave',
    'toolium_telefonica.behave', 'toolium_telefonica.behave.decorators',
}
STEP_KINDS = {'given', 'when', 'then', 'step'}
MATCHER_SELECTORS = {
    f'{module}.{name}'
    for module in ('behave', 'behave.api.step_matchers')
    for name in ('use_step_matcher', 'step_matcher')
}
FRAMEWORK_MODULES = ('toolium.behave', 'toolium_telefonica.behave')
Step = namedtuple('Step', 'path line symbol kind pattern')
StepGroup = namedtuple('StepGroup', 'literals templates')
CONVERTERS = {
    '': r'.+?', 'w': r'\w+', 'W': r'\W+', 's': r'\s+', 'S': r'\S+',
    'd': r'[+-]?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+)',
    'b': r'[01]+', 'o': r'[0-7]+', 'x': r'[0-9a-fA-F]+', 'n': r'\d{1,3}(?:[,\.]\d{3})*|\d+',
    'f': r'[+-]?(?:\d+\.\d*|\.\d+)',
    'e': r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)|(?i:nan|[+-]?inf)',
    'g': r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|(?i:nan|[+-]?inf)',
}


@lru_cache(maxsize=2048)
def read_module(path, revision):
    """Parse a source file once per filesystem revision."""
    try:
        with tokenize.open(path) as source:
            return ast.parse(source.read(), filename=str(path))
    except (OSError, SyntaxError, UnicodeError):
        return None


def source_tree(path):
    """Read a Python AST, invalidating the cached version after an edit or replacement."""
    try:
        stat = path.stat()
    except OSError:
        return None
    return read_module(path, (stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size, stat.st_ino))


def installed_roots():
    """Locate site-packages from the selected interpreter without evaluating .pth files."""
    interpreter = Path(sys.executable)
    virtualenv = interpreter.parent.parent
    if (virtualenv / 'pyvenv.cfg').is_file():
        # Before Python 3.14, -S can leave sys.prefix at the base interpreter.
        # Use the venv install scheme explicitly so distro-specific site paths do not hide installed packages.
        scheme = 'venv' if 'venv' in sysconfig.get_scheme_names() else ('nt' if os.name == 'nt' else 'posix_prefix')
        prefix = str(virtualenv)
        paths = sysconfig.get_paths(scheme, vars={'base': prefix, 'platbase': prefix})
        roots = [paths['purelib'], paths['platlib'], *site.getsitepackages([prefix])]
        config = (virtualenv / 'pyvenv.cfg').read_text(encoding='utf-8').lower()
        if not re.search(r'^include-system-site-packages\s*=\s*true\s*$', config, re.M):
            return tuple(map(Path, roots))
    else:
        roots = []
    return tuple(map(Path, [*roots, site.getusersitepackages(), *site.getsitepackages()]))


def suite_entries(directory, workspace):
    """Return the closest suite and its environment and direct step modules."""
    for parent in (directory, *directory.parents):
        steps = parent / 'steps'
        if steps.is_dir():
            environment = parent / 'environment.py'
            entries = [environment] if environment.is_file() else []
            return parent, entries + sorted(path for path in steps.glob('*.py') if path.is_file())
        if parent == workspace:
            break
    return None, []


def module_files(name, roots):
    """Resolve a dotted import to its source and any package initializers."""
    parts = name.split('.')
    if not all(part.isidentifier() for part in parts):
        return []
    for directory in roots:
        initializers = []
        for part in parts[:-1]:
            directory = directory / part
            init = directory / '__init__.py'
            if init.is_file():
                initializers.append(init)
        package = directory / parts[-1] / '__init__.py'
        module = directory / (parts[-1] + '.py')
        if package.is_file():
            return [*initializers, package]
        if module.is_file():
            return [*initializers, module]
    return []


def import_from(node, path, roots):
    """Resolve relative imports against the first source root containing the module."""
    if node.level == 0:
        return node.module or ''
    for root in sorted(roots, key=lambda item: -len(item.parts)):
        if root in path.parents:
            package = path.parent.relative_to(root).parts
            if len(package) >= node.level:
                base = package[:len(package) - node.level + 1]
                return '.'.join((*base, *([node.module] if node.module else [])))
    return ''


def qualified_name(node, bindings):
    """Resolve a decorator spelling through the module's import aliases."""
    if isinstance(node, ast.Name):
        return bindings.get(node.id, '')
    if isinstance(node, ast.Attribute):
        base = qualified_name(node.value, bindings)
        return f'{base}.{node.attr}' if base else ''
    return ''


@lru_cache(maxsize=2048)
def module_contents(tree, path, roots, direct_step):
    """Collect statically imported modules and literal step declarations in source order."""
    if tree is None:
        return [], []
    imports, steps, bindings = [], [], {}
    if direct_step:
        # The Behave runner injects these aliases before executing a direct step file.
        bindings = {name: f'behave.{name}' for kind in STEP_KINDS for name in (kind, kind.title())}
        bindings.update({name: f'behave.{name}' for name in ('use_step_matcher', 'step_matcher')})
    matcher = 'parse'
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(alias.name)
                head = alias.name.split('.')[0]
                bindings[alias.asname or head] = alias.name if alias.asname else head
        elif isinstance(node, ast.ImportFrom):
            base = import_from(node, path, roots)
            if not base:
                continue
            imports.append(base)
            for alias in node.names:
                if alias.name == '*':
                    if base in DECORATOR_MODULES:
                        bindings.update({kind: f'{base}.{kind}' for kind in STEP_KINDS})
                else:
                    name = f'{base}.{alias.name}'
                    imports.append(name)
                    bindings[alias.asname or alias.name] = name
        elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            call = node.value
            if qualified_name(call.func, bindings) in MATCHER_SELECTORS:
                matcher = call.args[0].value if call.args and isinstance(call.args[0], ast.Constant) else None
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and matcher == 'parse':
            for decorator in node.decorator_list:
                if not isinstance(decorator, ast.Call) or not decorator.args:
                    continue
                module, _, kind = qualified_name(decorator.func, bindings).rpartition('.')
                kind = kind.lower() if module.startswith('behave') else kind
                pattern = decorator.args[0]
                if (module in DECORATOR_MODULES and kind in STEP_KINDS
                        and isinstance(pattern, ast.Constant) and isinstance(pattern.value, str)):
                    steps.append(Step(str(path), node.lineno - 1, node.name, kind, pattern.value))
    return imports, steps


def collect_steps(entries, local_roots, package_roots):
    """Follow source imports and collect definitions once per reachable file."""
    modules = set()
    visited = set()
    work = list(reversed(entries))
    direct_steps = {path for path in entries if path.parent.name == 'steps'}
    all_roots = (*local_roots, *package_roots)
    steps = []
    while work:
        path = work.pop()
        if path in visited:
            continue
        visited.add(path)
        imports, declarations = module_contents(source_tree(path), path, all_roots, path in direct_steps)
        steps.extend(declarations)
        for name in reversed(imports):
            if name in modules:
                continue
            modules.add(name)
            is_framework = any(name == base or name.startswith(base + '.') for base in FRAMEWORK_MODULES)
            roots = all_roots if is_framework else local_roots
            work.extend(reversed(module_files(name, roots)))
    return steps, visited


@lru_cache(maxsize=4096)
def compile_pattern(pattern):
    """Translate a literal or basic parse pattern into a case-sensitive regex."""
    fields = {}
    parts = []
    try:
        for literal, name, spec, conversion in Formatter().parse(pattern):
            parts.append(re.escape(literal))
            if name is None:
                continue
            if conversion is not None or spec not in CONVERTERS:
                return None
            if name and name in fields:
                group, previous = fields[name]
                if previous != spec:
                    return None
                parts.append(f'(?P={group})')
            elif name:
                group = f'field{len(fields)}'
                fields[name] = (group, spec)
                parts.append(f'(?P<{group}>{CONVERTERS[spec]})')
            else:
                parts.append(f'(?:{CONVERTERS[spec]})')
        return re.compile(''.join(parts), re.DOTALL)
    except (ValueError, re.error):
        return None


@lru_cache(maxsize=16)
def group_steps(steps):
    """Index exact texts and precompile parameterized patterns by decorator."""
    groups = {}
    for order, step in enumerate(steps):
        try:
            fields = tuple(Formatter().parse(step.pattern))
        except ValueError:
            continue
        group = groups.setdefault(step.kind, StepGroup({}, []))
        if all(name is None for _, name, _, _ in fields):
            text = ''.join(literal for literal, _, _, _ in fields)
            group.literals.setdefault(text, []).append((order, step))
        else:
            pattern = compile_pattern(step.pattern)
            if pattern is not None:
                group.templates.append((order, step, pattern))
    return groups


def matching_steps(groups, kind, text):
    """Find matches in the first applicable group, preserving declaration order within it."""
    for key in ((kind, 'step') if kind != 'step' else ('step',)):
        group = groups.get(key)
        if group is None:
            continue
        matches = [*group.literals.get(text, ())]
        matches.extend((order, step) for order, step, pattern in group.templates if pattern.fullmatch(text))
        if matches:
            return [step for _, step in sorted(matches)]
    return []


def suite_steps(workspace, suite, entries, import_paths):
    """Load reachable steps and files using the given suite's static import roots."""

    # Behave exposes the feature root. The workspace and its ancestors down to that root
    # also cover shared modules imported from a project's test working directory.
    ancestors = [parent for parent in suite.parents if parent == workspace or workspace in parent.parents]
    local_roots = tuple(dict.fromkeys([
        suite / 'steps', suite, *ancestors, workspace, *import_paths,
    ]))
    return collect_steps(entries, local_roots, installed_roots())


def resolve(request):
    """Discover the suite and return matching locations for each expanded step."""
    workspace = Path(request['workspace'])
    directory = Path(request['suite']) if 'suite' in request else Path(request['feature']).parent
    suite, entries = suite_entries(directory, workspace)
    if suite is None:
        return {'suiteFound': False, 'matches': []}

    steps, _ = suite_steps(workspace, suite, entries, map(Path, request.get('importPaths', [])))
    groups = group_steps(tuple(steps))
    matches = {}
    for query in request['queries']:
        for step in matching_steps(groups, query['kind'], query['text']):
            matches.setdefault((step.path, step.line), step._asdict())
    return {'suiteFound': True, 'matches': list(matches.values())}


def execute_steps_snippet(request):
    """Find a single literal execute_steps argument covering the requested source position."""
    source = request['source'].replace('\r\n', '\n').replace('\r', '\n')
    line = request['line'] + 1
    column = request['column']
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None

    lines = source.split('\n')
    for call in ast.walk(tree):
        if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                and call.func.attr == 'execute_steps'):
            continue
        argument = call.args[0] if call.args else next(
            (keyword.value for keyword in call.keywords if keyword.arg == 'steps_text'), None,
        )
        if not (isinstance(argument, ast.Constant) and isinstance(argument.value, str)
                and argument.lineno <= line <= argument.end_lineno):
            continue

        # AST columns count UTF-8 bytes, while the cursor column counts Unicode code points.
        start = len(lines[argument.lineno - 1].encode()[:argument.col_offset].decode())
        end = len(lines[argument.end_lineno - 1].encode()[:argument.end_col_offset].decode())
        if (line, column) < (argument.lineno, start) or (line, column) >= (argument.end_lineno, end):
            continue
        segment = ast.get_source_segment(source, argument)
        tokens = list(tokenize.generate_tokens(StringIO(segment).readline))
        strings = [token for token in tokens if token.type == tokenize.STRING]
        if len(strings) != 1:
            continue

        # Check each physical line so escapes or continuations cannot shift the source mapping.
        raw_lines = segment.split('\n')
        decoded_lines = argument.value.split('\n')
        if len(raw_lines) != len(decoded_lines) or any(
            raw.rstrip('\r').endswith('\\') for raw in raw_lines[:-1]
        ):
            continue
        return {'text': argument.value, 'line': line - argument.lineno}
    return None


def inspect_python(request):
    """Return the literal under the cursor and its nearest suite, if any."""
    snippet = execute_steps_snippet(request)
    if snippet is None:
        return None
    workspace = Path(request['workspace'])
    path = Path(request['path'])
    suite, _ = suite_entries(path.parent, workspace)
    return {**snippet, 'suite': str(suite) if suite is not None else None}


def find_suites(request):
    """Filter candidate roots to suites that statically reach a shared Python module."""
    workspace = Path(request['workspace'])
    path = Path(request['path']).resolve()
    import_paths = tuple(map(Path, request.get('importPaths', [])))
    matches = []
    for candidate in map(Path, request['suites']):
        suite, entries = suite_entries(candidate, workspace)
        if suite != candidate:
            continue
        _, files = suite_steps(workspace, suite, entries, import_paths)
        if any(file.resolve() == path for file in files):
            matches.append(str(suite))
    return matches


def serve():
    """Read JSON line requests and write one JSON response per request."""
    for line in sys.stdin:
        try:
            request = json.loads(line)
            operation = {'resolve': resolve, 'inspectPython': inspect_python, 'findSuites': find_suites}
            response = {'result': operation[request.get('operation', 'resolve')](request)}
        except (OSError, ValueError, KeyError, tokenize.TokenError) as error:
            response = {'error': str(error)}
        print(json.dumps(response), flush=True)


if __name__ == '__main__':
    serve()
