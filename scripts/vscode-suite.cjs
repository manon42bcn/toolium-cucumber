const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const vscode = require('vscode');

/** Write an invented source file into the temporary test workspace. */
async function write(workspace, file, text) {
  const uri = vscode.Uri.joinPath(workspace, file);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
  return uri;
}

/** Return the extension's function suggestions at the requested source position. */
async function suggestions(document, line, column = document.lineAt(line).range.end.character) {
  const position = new vscode.Position(line, column);
  const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position);
  return list.items.filter((item) => item.kind === vscode.CompletionItemKind.Function);
}

/** Verify Python completion detection, suite scope, and snippet insertion through VS Code. */
async function testPythonCompletion(workspace) {
  const extension = vscode.extensions.all.find(({ packageJSON }) => packageJSON.name === 'toolium-cucumber');
  await extension.activate();

  const caller = await write(workspace, 'shared/observer.py', [
    'def observe(context, title):',
    '    """Run invented observation steps."""',
    '    context.execute_steps("""',
    '        When I focus the lens',
    '        And I op',
    '    """)',
    '    example = """',
    '        When I op',
    '    """',
    '    context.execute_steps(f"""',
    '        When I open {title}',
    '    """)',
    '    context.execute_steps("""When I op""")',
    '    context.execute_steps(r"""',
    '        When I op',
    '    """)'
  ].join('\n'));
  await write(workspace, 'one/features/steps/charts.py', [
    'from behave import when, then',
    'from shared.observer import observe',
    '@when(r\'I open "{title}" at C:\\charts\')',
    'def open_chart(context, title):',
    '    """Open an invented chart."""',
    '@when("I open the common chart")',
    'def common_chart(context): pass',
    '@then("I open an outcome chart")',
    'def outcome_chart(context): pass'
  ].join('\n'));
  await write(workspace, 'two/features/steps/charts.py', [
    'from behave import when',
    'from shared.observer import observe',
    '@when("I open the common chart")',
    'def common_chart(context): pass',
    '@when("I open the second chart")',
    'def second_chart(context): pass'
  ].join('\n'));
  await write(workspace, 'other/features/steps/charts.py', [
    'from behave import when',
    '@when("I open an unrelated chart")',
    'def unrelated_chart(context): pass'
  ].join('\n'));

  const document = await vscode.workspace.openTextDocument(caller);
  const editor = await vscode.window.showTextDocument(document);
  const items = await suggestions(document, 4);
  assert.deepEqual(items.map(({ label }) => label).sort(), [
    String.raw`I open "{title}" at C:\charts`, 'I open the common chart', 'I open the second chart'
  ].sort());

  const item = items.find(({ insertText }) => insertText instanceof vscode.SnippetString && insertText.value.includes('${1:title}'));
  assert.ok(item, 'The title parameter should be an editable snippet field');
  assert.ok(await editor.insertSnippet(item.insertText, item.range.replacing));
  assert.equal(document.lineAt(4).text, String.raw`        And I open \"title\" at C:\\charts`);

  assert.deepEqual(await suggestions(document, 7), []);
  assert.deepEqual(await suggestions(document, 10), []);
  assert.deepEqual(await suggestions(document, 12, document.lineAt(12).text.indexOf('I op') + 4), []);
  const raw = await suggestions(document, 14);
  assert.deepEqual(raw.map(({ label }) => label).sort(), ['I open the common chart', 'I open the second chart']);
}

/** Wait for asynchronous feature validation to publish the expected diagnostics. */
async function waitForDiagnostics(uri, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    if (predicate(diagnostics)) {
      return diagnostics;
    }
    await delay(50);
  }
  assert.fail('Expected feature diagnostics were not published: ' + JSON.stringify(vscode.languages.getDiagnostics(uri)));
}

/** Verify Examples diagnostics and create a step through the editor's Quick Fix API. */
async function testFeatureDiagnostics(workspace) {
  await write(workspace, 'diagnostics/features/steps/figures.py', [
    'from behave import step',
    '@step("I record a circle")',
    'def record_circle(context): pass'
  ].join('\n'));
  const feature = await write(workspace, 'diagnostics/features/figures.feature', [
    'Feature: Draw figures',
    '  Scenario Outline: Record a figure',
    '    Given I record a <figure>',
    '    And I use <ink>',
    '    Examples:',
    '      | figure |',
    '      | circle |',
    '      | square |'
  ].join('\n'));
  const document = await vscode.workspace.openTextDocument(feature);
  await vscode.window.showTextDocument(document);
  const before = await waitForDiagnostics(feature, (entries) =>
    entries.some(({ code }) => code === 'undefined-step') && entries.some(({ code }) => code === 'missing-examples-columns'));
  const warning = before.find(({ code }) => code === 'undefined-step');
  assert.match(warning.message, /square/);
  assert.equal(document.getText(warning.range), 'Given I record a <figure>');
  assert.match(before.find(({ code }) => code === 'missing-examples-columns').message, /<ink>/);

  const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', feature, warning.range, 'quickfix');
  const action = actions.find(({ title }) => title === 'Create Python step definition');
  assert.ok(action);
  await vscode.commands.executeCommand(action.command.command, ...action.command.arguments);
  const generated = vscode.window.activeTextEditor.document;
  assert.match(generated.fileName, /step_i_record_a_square\.py$/);
  assert.match(generated.getText(), /@step\("I record a square"\)/);
  await waitForDiagnostics(feature, (entries) =>
    entries.length === 1 && entries[0].code === 'missing-examples-columns');

  await write(workspace, 'diagnostics/features/steps/custom.py', [
    'from behave import step',
    '@step("I choose {value:CustomType}")',
    'def choose(context, value): pass'
  ].join('\n'));
  const partial = await waitForDiagnostics(feature, (entries) =>
    entries.some(({ message }) => message.includes('Step validation is incomplete')));
  assert.ok(!partial.some(({ code }) => code === 'undefined-step'));
}

/** Report the test outcome to the launcher, including when VS Code starts asynchronously. */
exports.run = async function () {
  const workspace = vscode.workspace.workspaceFolders[0].uri;
  try {
    await testPythonCompletion(workspace);
    await testFeatureDiagnostics(workspace);
    await write(workspace, '.passed', 'passed\n');
  } catch (error) {
    await write(workspace, '.failed', error.stack ?? String(error));
    throw error;
  }
};
