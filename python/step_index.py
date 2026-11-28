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
TOOLIUM_STEP_WRAPPERS = {
    '_toolium_step', '_toolium_api_step', '_toolium_statistics_step', '_toolium_deprecated_step',
    'statistics_step', 'deprecated_step',
}
MATCHER_SELECTORS = {
    f'{module}.{name}'
    for module in ('behave', 'behave.api.step_matchers')
    for name in ('use_step_matcher', 'step_matcher')
}
FRAMEWORK_MODULES = ('toolium.behave', 'toolium_telefonica.behave')
Step = namedtuple('Step', 'path line symbol kind pattern documentation')
StepGroup = namedtuple('StepGroup', 'literals templates')
CoverageIssue = namedtuple('CoverageIssue', 'code path line message')
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
            return ast.parse(source.read(), filename=str(path)), None
    except SyntaxError as error:
        return None, CoverageIssue('python-syntax', str(path), max(0, (error.lineno or 1) - 1), error.msg)
    except (OSError, UnicodeError):
        return None, CoverageIssue('unreadable-source', str(path), 0, 'Unable to read the Python source.')


def source_tree(path):
    """Read a Python AST, invalidating the cached version after an edit or replacement."""
    try:
        stat = path.stat()
    except OSError:
        return None, CoverageIssue('unreadable-source', str(path), 0, 'Unable to read the Python source.')
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


def decorator_kind(qualified):
    """Map a Behave decorator or Toolium wrapper to the kind registered at runtime."""
    module, _, name = qualified.rpartition('.')
    if module not in DECORATOR_MODULES:
        return None
    if module.startswith('behave'):
        name = name.lower()
    if name in STEP_KINDS:
        return name
    if module.startswith('toolium_telefonica.behave') and name in TOOLIUM_STEP_WRAPPERS:
        return 'step'
    return None


def module_execution_nodes(tree):
    """Return the nodes evaluated at import time, excluding function and class bodies."""
    pending = list(tree.body)
    nodes = set()
    while pending:
        node = pending.pop()
        nodes.add(node)
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            pending.extend(ast.iter_child_nodes(node))
    return nodes


@lru_cache(maxsize=2048)
def module_contents(tree, path, roots, direct_step):
    """Collect static imports and step definitions, recording unsupported registrations."""
    imports, steps, bindings, issues = [], [], {}, set()
    inspected_decorators = set()
    top_level = set(tree.body)
    if direct_step:
        # The Behave runner injects these aliases before executing a direct step file.
        bindings = {name: f'behave.{name}' for kind in STEP_KINDS for name in (kind, kind.title())}
        bindings.update({name: f'behave.{name}' for name in ('use_step_matcher', 'step_matcher')})
    matcher = 'parse'
    for node in tree.body:
        line = node.lineno - 1
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append((alias.name, True, line))
                head = alias.name.split('.')[0]
                bindings[alias.asname or head] = alias.name if alias.asname else head
        elif isinstance(node, ast.ImportFrom):
            base = import_from(node, path, roots)
            if not base:
                issues.add(CoverageIssue('unresolved-import', str(path), line, 'Unable to resolve a relative import.'))
                continue
            imports.append((base, True, line))
            for alias in node.names:
                if alias.name == '*':
                    if base in DECORATOR_MODULES:
                        names = STEP_KINDS | TOOLIUM_STEP_WRAPPERS if base.startswith('toolium_telefonica') else STEP_KINDS
                        bindings.update({name: f'{base}.{name}' for name in names if not name.startswith('_')})
                else:
                    name = f'{base}.{alias.name}'
                    imports.append((name, False, line))
                    bindings[alias.asname or alias.name] = name
        elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            call = node.value
            if qualified_name(call.func, bindings) in MATCHER_SELECTORS:
                matcher = call.args[0].value if call.args and isinstance(call.args[0], ast.Constant) else None
                if matcher != 'parse':
                    name = repr(matcher) if matcher is not None else 'a dynamic value'
                    issues.add(CoverageIssue('unsupported-matcher', str(path), line, f'Unsupported step matcher: {name}.'))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for decorator in node.decorator_list:
                if not isinstance(decorator, ast.Call):
                    continue
                kind = decorator_kind(qualified_name(decorator.func, bindings))
                if kind is None:
                    continue
                inspected_decorators.add(decorator)
                if matcher != 'parse':
                    continue
                pattern = decorator.args[0] if decorator.args else None
                if not (isinstance(pattern, ast.Constant) and isinstance(pattern.value, str)):
                    issues.add(CoverageIssue(
                        'dynamic-pattern', str(path), decorator.lineno - 1, 'The step decorator requires a static string.',
                    ))
                elif compile_pattern(pattern.value) is None:
                    issues.add(CoverageIssue(
                        'unsupported-pattern', str(path), decorator.lineno - 1,
                        f'Unsupported parse pattern for {node.name}.',
                    ))
                else:
                    steps.append(Step(str(path), line, node.name, kind, pattern.value, ast.get_docstring(node)))

    # Toolium uses lazy imports for configuration and page objects unrelated to step discovery.
    # Flag module-level dynamic imports and function-level imports that explicitly name a step module.
    executed = module_execution_nodes(tree)
    registry_calls = {'add_step_definition', 'register_step_matcher_class', 'register_type'}
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = getattr(node.func, 'id', '') or getattr(node.func, 'attr', '')
            qualified = qualified_name(node.func, bindings)
            dynamic_import = name in ('import_module', '__import__') or qualified == 'importlib.import_module'
            imports_steps = node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str) \
                and 'steps' in node.args[0].value.split('.')
            if ((dynamic_import and (node in executed or imports_steps))
                    or (name in registry_calls and (node in executed or qualified.startswith('behave.')))
                    or (node not in inspected_decorators and decorator_kind(qualified) is not None)):
                issues.add(CoverageIssue(
                    'dynamic-registration', str(path), node.lineno - 1, f'Static analysis cannot follow {name}().',
                ))
        if isinstance(node, (ast.Import, ast.ImportFrom)) and node not in top_level:
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            else:
                base = node.module or ''
                names = [base, *[f'{base}.{alias.name}' for alias in node.names if alias.name == 'steps']]
            for name in names:
                if 'steps' in name.split('.'):
                    issues.add(CoverageIssue(
                        'conditional-import', str(path), node.lineno - 1, f'Step import outside module scope: {name}.',
                    ))
    return imports, steps, issues


def collect_steps(entries, local_roots, package_roots):
    """Follow source imports and collect definitions once per reachable file."""
    modules = {}
    visited = set()
    work = list(reversed(entries))
    direct_steps = {path for path in entries if path.parent.name == 'steps'}
    all_roots = (*local_roots, *package_roots)
    steps = []
    issues = set()
    while work:
        path = work.pop()
        if path in visited:
            continue
        visited.add(path)
        tree, unreadable = source_tree(path)
        if unreadable:
            issues.add(unreadable)
            continue
        imports, declarations, partial = module_contents(tree, path, all_roots, path in direct_steps)
        steps.extend(declarations)
        issues.update(partial)
        for name, required, line in reversed(imports):
            is_framework = any(name == base or name.startswith(base + '.') for base in FRAMEWORK_MODULES)
            roots = all_roots if is_framework else local_roots
            if name not in modules:
                modules[name] = module_files(name, roots)
                work.extend(reversed(modules[name]))
            if required and not modules[name]:
                package = Path(*name.split('.'))
                is_step_import = is_framework or 'steps' in name.split('.')
                is_local = any((root / package.parts[0]).is_dir() for root in local_roots)
                if (is_step_import or is_local) and not any((root / package).is_dir() for root in roots):
                    issues.add(CoverageIssue(
                        'unresolved-import', str(path), line, f'Unable to locate step import: {name}.',
                    ))
    return steps, visited, sorted(issues, key=lambda issue: (issue.path, issue.line, issue.code, issue.message))


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


def request_groups(request):
    """Load the selected suite's groups and whether discovery detected unsupported content."""
    workspace = Path(request['workspace'])
    directory = Path(request['suite']) if 'suite' in request else Path(request['feature']).parent
    suite, entries = suite_entries(directory, workspace)
    if suite is None:
        return None

    steps, _, issues = suite_steps(workspace, suite, entries, map(Path, request.get('importPaths', [])))
    return group_steps(tuple(steps)), suite, issues


def resolve(request):
    """Return matching locations for each expanded step in the selected suite."""
    index = request_groups(request)
    if index is None:
        return {'suiteFound': False, 'matches': []}
    groups, _, _ = index
    matches = {}
    for query in request['queries']:
        for step in matching_steps(groups, query['kind'], query['text']):
            matches.setdefault((step.path, step.line), step._asdict())
    return {'suiteFound': True, 'matches': list(matches.values())}


def diagnose(request):
    """Check a batch of queries only when the selected suite is statically covered."""
    index = request_groups(request)
    if index is None:
        return {'status': 'unavailable'}
    groups, suite, issues = index
    if issues:
        return {'status': 'incomplete', 'issues': [issue._asdict() for issue in issues[:20]], 'issueCount': len(issues)}
    return {
        'status': 'complete',
        'stepsDirectory': str(suite / 'steps'),
        'missing': [
            position for position, query in enumerate(request['queries'])
            if not matching_steps(groups, query['kind'], query['text'])
        ],
    }


@lru_cache(maxsize=4096)
def completion_parts(pattern):
    """Describe literal and editable segments without embedding editor snippet syntax."""
    parts = []
    for literal, name, spec, _ in Formatter().parse(pattern):
        if literal:
            parts.append({'text': literal})
        if name is not None:
            parts.append({'name': name or None, 'type': spec})
    return parts


def complete(request):
    """Suggest distinct patterns from the applicable decorator groups."""
    index = request_groups(request)
    if index is None:
        return {'items': [], 'incomplete': False}
    groups, _, _ = index

    kind = request['kind']
    prefix = request['prefix'].casefold()
    items = {}
    for key in ((kind, 'step') if kind != 'step' else ('step',)):
        group = groups.get(key)
        if group is None:
            continue
        for text, entries in group.literals.items():
            if text.casefold().startswith(prefix):
                _, step = entries[0]
                items.setdefault(('literal', text), {**step._asdict(), 'parts': [{'text': text}]})
        for _, step, _ in group.templates:
            parts = completion_parts(step.pattern)
            literal = parts[0].get('text', '').casefold()
            if literal.startswith(prefix) or prefix.startswith(literal):
                items.setdefault(('template', step.pattern), {**step._asdict(), 'parts': parts})

    limit = 100
    return {'items': list(items.values())[:limit], 'incomplete': len(items) > limit}


def formatted_step_snippet(segment, offset):
    """Return completion context for an interior f-string line without replacement fields."""
    lines = segment.split('\n')
    opening = re.match(r"(?i)(fr|rf|f)(\"\"\"|''')", segment)
    if not opening or not 0 < offset < len(lines) - 1 or re.search(r"[{}\\]", lines[offset]):
        return None

    tokens = list(tokenize.generate_tokens(StringIO(segment).readline))
    depth = 0
    strings = 0
    for token in tokens:
        # Python 3.12 and newer tokenize f-strings separately from ordinary strings.
        name = tokenize.tok_name[token.type]
        if name == 'FSTRING_START':
            strings += depth == 0
            depth += 1
        elif name == 'FSTRING_END':
            depth -= 1
        elif name == 'STRING' and depth == 0:
            strings += 1
    if strings != 1:
        return None

    # A physical line can sit inside a multiline Python expression even when it has no braces.
    # Verify the probe reaches a top-level literal part without evaluating the f-string.
    marker = '__toolium_completion_probe__'
    while marker in segment:
        marker += '_'
    probe = lines.copy()
    probe[offset] += marker
    try:
        expression = ast.parse('\n'.join(probe), mode='eval').body
    except SyntaxError:
        return None
    if not isinstance(expression, ast.JoinedStr) or not any(
        isinstance(part, ast.Constant) and marker in part.value for part in expression.values
    ):
        return None

    return {'text': segment, 'line': offset, 'completion': {
        'quote': opening[2][0], 'raw': 'r' in opening[1].lower(), 'formatted': True,
    }}


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
        if not isinstance(argument, (ast.Constant, ast.JoinedStr)) or not argument.lineno <= line <= argument.end_lineno:
            continue

        # AST columns count UTF-8 bytes, while the cursor column counts Unicode code points.
        start = len(lines[argument.lineno - 1].encode()[:argument.col_offset].decode())
        end = len(lines[argument.end_lineno - 1].encode()[:argument.end_col_offset].decode())
        if (line, column) < (argument.lineno, start) or (line, column) >= (argument.end_lineno, end):
            continue
        segment = ast.get_source_segment(source, argument)
        if isinstance(argument, ast.JoinedStr):
            return formatted_step_snippet(segment, line - argument.lineno)
        if not isinstance(argument.value, str):
            continue
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
        offset = line - argument.lineno
        completion = None
        opening = re.match(r"(?i)([ru]?)(\"\"\"|''')", segment)
        # Only edit interior lines whose source columns match the decoded step string.
        if opening and 0 < offset < len(raw_lines) - 1 and raw_lines[offset] == decoded_lines[offset]:
            completion = {'quote': opening[2][0], 'raw': opening[1].lower() == 'r'}
        return {'text': argument.value, 'line': offset, 'completion': completion}
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
        _, files, _ = suite_steps(workspace, suite, entries, import_paths)
        if any(file.resolve() == path for file in files):
            matches.append(str(suite))
    return matches


def serve():
    """Read JSON line requests and write one JSON response per request."""
    for line in sys.stdin:
        try:
            request = json.loads(line)
            operation = {
                'resolve': resolve, 'complete': complete, 'diagnose': diagnose,
                'inspectPython': inspect_python, 'findSuites': find_suites,
            }
            response = {'result': operation[request.get('operation', 'resolve')](request)}
        except (OSError, ValueError, KeyError, tokenize.TokenError) as error:
            response = {'error': str(error)}
        print(json.dumps(response), flush=True)


if __name__ == '__main__':
    serve()
