const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { test } = require('node:test');
const { actionStepQuery, parseFeature, snippetStepQueries, stepQueries } = require('../out/feature');
const { StepIndex } = require('../out/step-index');

const extension = resolve(__dirname, '..');
const python = process.platform === 'win32' ? 'python' : 'python3';

/** Write an invented suite file and return its absolute path. */
function write(workspace, relativePath, source) {
  const path = join(workspace, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

test('resolves conjunctive steps, wildcard steps, and distinct Examples rows', () => {
  const { document, issues } = parseFeature([
    'Feature: View the sky',
    '  Background:',
    '    Given an empty chart',
    '    When the lens is focused',
    '  Rule: Use the active lens',
    '    Scenario Outline: Mark a star',
    '      And I mark <star>',
    '      Then the chart is saved',
    '      * the chart contains one mark',
    '      Examples:',
    '        | star  |',
    '        | Vega  |',
    '        | $Moon |',
    '        | Vega  |'
  ].join('\n'));
  assert.deepEqual(issues, []);
  assert.deepEqual(stepQueries(document.feature, 6), [
    { kind: 'when', text: 'I mark Vega' },
    { kind: 'when', text: 'I mark $Moon' }
  ]);
  assert.deepEqual(stepQueries(document.feature, 8), [{ kind: 'then', text: 'the chart contains one mark' }]);
  assert.deepEqual(stepQueries(document.feature, 9), []);
});

test('finds steps in Toolium action blocks without interpreting prose or doc strings as steps', () => {
  const source = [
    'Feature: View the sky',
    '  Given this line is prose',
    '  Actions Before the Feature:',
    '    Setup an empty chart',
    '      """',
    '      Given this line is a note',
    '      """',
    '  Actions After Each Scenario:',
    '    Then close the dome',
    '  Actions Before Each Scenario:',
    '    Check the dome is open',
    '  Actions After the Feature:',
    '    And store the chart',
    '  Scenario: Record a star',
    '    Given a bright star'
  ].join('\n');
  const { document } = parseFeature(source);
  assert.deepEqual(actionStepQuery(document.feature, source, 1), []);
  assert.deepEqual(actionStepQuery(document.feature, source, 3), [{ kind: 'given', text: 'an empty chart' }]);
  assert.deepEqual(actionStepQuery(document.feature, source, 5), []);
  assert.deepEqual(actionStepQuery(document.feature, source, 8), [{ kind: 'given', text: 'close the dome' }]);
  assert.deepEqual(actionStepQuery(document.feature, source, 10), [{ kind: 'given', text: 'the dome is open' }]);
  assert.deepEqual(actionStepQuery(document.feature, source, 12), [{ kind: 'given', text: 'store the chart' }]);
  assert.deepEqual(actionStepQuery(document.feature, source, 14), []);
});

test('resolves direct, shared, and installed steps with an isolated, refreshable index', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'toolium-step-index-'));
  const index = new StepIndex(extension);
  try {
    const virtualenv = join(workspace, '.venv');
    execFileSync(python, ['-I', '-S', '-m', 'venv', '--without-pip', virtualenv]);
    const interpreter = process.platform === 'win32'
      ? join(virtualenv, 'Scripts', 'python.exe')
      : join(virtualenv, 'bin', 'python');
    const installed = execFileSync(interpreter, ['-I', '-c',
      'import sysconfig; print(sysconfig.get_path("purelib"))'
    ], { encoding: 'utf8' }).trim();
    // Some distributions report a different site directory under -S than their venv install scheme.
    const isolatedRoots = execFileSync(interpreter, ['-I', '-S', '-c', [
      'import json, runpy, site, sys',
      'site.getsitepackages = lambda prefixes=None: [sys.argv[2]]',
      'worker = runpy.run_path(sys.argv[1])',
      'print(json.dumps([str(root) for root in worker["installed_roots"]()]))'
    ].join('\n'), join(extension, 'python', 'step_index.py'), join(virtualenv, 'dist-packages')], { encoding: 'utf8' });
    assert.ok(JSON.parse(isolatedRoots).includes(installed), 'Isolated discovery must include the venv install path');

    const feature = write(workspace, 'qa/features/group/stars.feature', 'Feature: View the sky\n');
    const direct = write(workspace, 'qa/features/steps/definitions.py', [
      'from shared.steps import *',
      'from toolium_telefonica.behave.steps.sky import *',
      'raise RuntimeError("Project modules must be read without importing them.")',
      '@Given("a chart with {count:d} marks")',
      'def chart(context, count): pass',
      '@step("a chart with {count} marks")',
      'def fallback(context, count): pass',
      '@then("a second chart")',
      '@then("an extra chart")',
      'async def second_chart(context): pass'
    ].join('\n'));
    write(workspace, 'qa/shared/steps/__init__.py', 'from .lenses import *\n');
    const shared = write(workspace, 'qa/shared/steps/lenses.py', [
      'from behave import when as action',
      '@action("I focus the lens")',
      'def focus(context): pass'
    ].join('\n'));
    const packaged = write(installed, 'toolium_telefonica/behave/steps/sky.py', [
      'import toolium_telefonica.behave as framework',
      '@framework.then("the star appears")',
      'def visible(context): pass'
    ].join('\n'));
    write(workspace, 'qa/other/steps/unused.py',
      '@given("a chart with {count:d} marks")\ndef unrelated(context, count): pass\n');
    const request = { workspace, feature, importPaths: [] };
    /** Look up one expanded step in the invented suite. */
    const lookup = (kind, text) => index.resolve(interpreter, { ...request, queries: [{ kind, text }] });

    const { suiteFound, matches } = await lookup('given', 'a chart with 2 marks');
    assert.ok(suiteFound);
    assert.deepEqual(matches.map(({ path, line, symbol }) => [path, line, symbol]), [[direct, 4, 'chart']]);
    assert.equal((await lookup('given', 'a chart with two marks')).matches[0].symbol, 'fallback');
    assert.deepEqual((await lookup('given', 'A chart with 2 marks')).matches, []);
    assert.equal((await lookup('then', 'an extra chart')).matches[0].symbol, 'second_chart');
    assert.equal((await lookup('when', 'I focus the lens')).matches[0].path, shared);
    assert.deepEqual((await lookup('given', 'I focus the lens')).matches, []);
    assert.deepEqual((await lookup('then', 'the star appears')).matches.map(({ path }) => path), [packaged]);

    write(workspace, 'qa/shared/steps/lenses.py',
      'from behave import when\n@when("I polish the new lens")\ndef polish(context): pass\n');
    assert.deepEqual((await lookup('when', 'I focus the lens')).matches, []);
    assert.equal((await lookup('when', 'I polish the new lens')).matches[0].symbol, 'polish');

    const added = write(workspace, 'qa/features/steps/new.py', '@step("an open dome")\ndef dome(context): pass\n');
    assert.equal((await lookup('given', 'an open dome')).matches[0].path, added);
    write(workspace, 'qa/features/steps/new.py', [
      '@step("an {state} dome")',
      'def any_dome(context, state): pass',
      '@step("an open dome")',
      'def dome(context): pass',
      '@step("a literal {{brace}}")',
      'def brace(context): pass'
    ].join('\n'));
    assert.deepEqual((await lookup('given', 'an open dome')).matches.map(({ symbol }) => symbol), ['any_dome', 'dome']);
    assert.equal((await lookup('given', 'a literal {brace}')).matches[0].symbol, 'brace');
    rmSync(added);
    assert.deepEqual((await lookup('given', 'an open dome')).matches, []);
  } finally {
    index.dispose();
    rmSync(workspace, { force: true, recursive: true });
  }
});

test('extracts only literal execute_steps calls and identifies suites importing a shared caller', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'toolium-step-snippet-'));
  const index = new StepIndex(extension);
  try {
    const source = [
      'def open_chart(context):',
      '    description = """Given this is prose"""',
      '    context.execute_steps("""',
      '        When I focus the lens',
      '        And I open the chart',
      '    """)',
      '    context.execute_steps(f"Given a {description}")',
      '    context.execute_steps("Given a " "chart")',
      '    context.execute_steps("Given a chart")'
    ].join('\n');
    const path = write(workspace, 'shared/caller.py', source);
    const first = write(workspace, 'one/features/steps/entry.py', 'from shared.caller import open_chart\n');
    write(workspace, 'two/features/steps/entry.py', 'import shared.caller\n');
    write(workspace, 'other/features/steps/entry.py', '# This suite does not import the caller.\n');
    const suites = ['one', 'two', 'other'].map((name) => join(workspace, name, 'features'));
    /** Inspect a cursor location in the current Python editor buffer. */
    const inspect = (line, column) => index.inspectPython(python, { workspace, path, source, line, column });
    const result = await inspect(4, 10);
    assert.equal(result.suite, null);
    assert.deepEqual(snippetStepQueries(result.text, result.line), [{ kind: 'when', text: 'I open the chart' }]);
    assert.equal(await inspect(1, 30), null);
    assert.equal(await inspect(6, 35), null);
    assert.equal(await inspect(7, 35), null);
    assert.equal(await inspect(8, 10), null);
    const inline = await inspect(8, 35);
    assert.deepEqual(snippetStepQueries(inline.text, inline.line), [{ kind: 'given', text: 'a chart' }]);
    assert.deepEqual(await index.findSuites(python, { workspace, path, suites, importPaths: [] }), suites.slice(0, 2));
    assert.equal((await index.inspectPython(python, {
      workspace, path: first, source, line: 4, column: 10
    })).suite, suites[0]);
  } finally {
    index.dispose();
    rmSync(workspace, { force: true, recursive: true });
  }
});
