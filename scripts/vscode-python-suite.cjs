const assert = require('node:assert/strict');
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

/** Report the test outcome to the launcher, including when VS Code starts asynchronously. */
exports.run = async function () {
  const workspace = vscode.workspace.workspaceFolders[0].uri;
  try {
    await testPythonCompletion(workspace);
    await write(workspace, '.passed', 'passed\n');
  } catch (error) {
    await write(workspace, '.failed', error.stack ?? String(error));
    throw error;
  }
};
