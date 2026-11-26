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

/** Verify resource completion, direct navigation, and references with unsaved resource edits. */
async function testResourceNavigation(workspace) {
  const resource = await write(workspace, 'acceptance/resources/language/observatory.yaml', [
    'observatory:',
    '  heading:',
    '    en: Welcome to the observatory'
  ].join('\n'));
  const source = await write(workspace, 'acceptance/features/observatory.feature', [
    'Feature: Observe the sky',
    '  Scenario: Read the display',
    '    Given the display says "[LANG:observatory.status::en]"'
  ].join('\n'));
  const editing = await write(workspace, 'acceptance/common/display.py', 'message = "[LANG:observatory.st"\n');

  const resourceDocument = await vscode.workspace.openTextDocument(resource);
  const resourceEditor = await vscode.window.showTextDocument(resourceDocument);
  assert.ok(await resourceEditor.edit((edit) => edit.replace(new vscode.Range(1, 2, 1, 9), 'status')));
  assert.ok(resourceDocument.isDirty);

  const caller = await vscode.workspace.openTextDocument(editing);
  await vscode.window.showTextDocument(caller);
  const completionPosition = new vscode.Position(0, caller.lineAt(0).text.indexOf('.st') + 3);
  const completion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', editing, completionPosition);
  assert.ok(completion.items.some(({ label, kind }) => label === 'status' && kind === vscode.CompletionItemKind.Property));

  const sourceDocument = await vscode.workspace.openTextDocument(source);
  const position = new vscode.Position(2, sourceDocument.lineAt(2).text.indexOf('LANG'));
  await vscode.window.showTextDocument(sourceDocument, { selection: new vscode.Range(position, position) });
  const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', source, position);
  assert.ok(hover.flatMap(({ contents }) => contents).some(({ value }) => value.includes('command:toolium-cucumber.openResource')));
  await vscode.commands.executeCommand('toolium-cucumber.openResource');
  assert.equal(vscode.window.activeTextEditor.document.uri.toString(), resource.toString());
  assert.equal(vscode.window.activeTextEditor.selection.start.line, 2);

  const usages = await vscode.commands.executeCommand('vscode.executeReferenceProvider', resource, new vscode.Position(1, 3));
  assert.deepEqual(usages.map(({ uri }) => uri.toString()), [source.toString()]);
  assert.equal(sourceDocument.getText(usages[0].range), '[LANG:observatory.status::en]');
}

/** Verify the Jira summary quick fix updates only the feature-level tag. */
async function testJiraSummary(workspace) {
  const uri = await write(workspace, 'jira/figures.feature', [
    '@US.ORBIT-4:ORBIT-8 @smoke',
    'Feature: Draw figures',
    '  @jira.ac.ORBIT-4#AC1 @jira.ac.ORBIT-7#AC1,AC2',
    '  Scenario: Record a figure',
    '    Given a circle'
  ].join('\n'));
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  const entries = await waitForDiagnostics(uri, (items) => items.some(({ code }) => code === 'missing-jira-stories'));
  const diagnostic = entries.find(({ code }) => code === 'missing-jira-stories');
  assert.equal(document.getText(diagnostic.range), '@US.ORBIT-4:ORBIT-8');
  const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', uri, diagnostic.range, 'quickfix');
  const action = actions.find(({ title }) => title === 'Update feature @US tag');
  assert.ok(action?.edit);
  assert.ok(await vscode.workspace.applyEdit(action.edit));
  assert.equal(document.lineAt(0).text, '@US.ORBIT-4:ORBIT-8:ORBIT-7 @smoke');
  await waitForDiagnostics(uri, (items) => !items.some(({ code }) => code === 'missing-jira-stories'));
  await vscode.commands.executeCommand('toolium-cucumber.cleanJiraStorySummary');
  assert.equal(document.lineAt(0).text, '@US.ORBIT-4:ORBIT-7 @smoke');
}

/** Verify that the Jira search opens the exact Examples cell from unsaved text. */
async function testJiraBugSearch(workspace) {
  await vscode.workspace.getConfiguration('tooliumCucumber.jira', workspace)
    .update('bugPrefixes', ['TOOLIUM'], vscode.ConfigurationTarget.Workspace);
  const uri = await write(workspace, 'jira/bugs.feature', [
    'Feature: Track an observation',
    '  @jira.link.detects.TOOLIUM-42:<bug_id>',
    '  Scenario Outline: Observe a sample',
    '    Given a sample',
    '    Examples:',
    '      | bug_id      |',
    '      | TOOLIUM-999 |'
  ].join('\n'));
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand('toolium-cucumber.findJiraBugReferences', 'TOOLIUM-42');
  assert.equal(document.getText(editor.selection), 'TOOLIUM-42');
  assert.ok(await editor.edit((edit) => edit.replace(new vscode.Range(6, 8, 6, 19), 'TOOLIUM-123')));
  assert.ok(document.isDirty);
  await vscode.commands.executeCommand('toolium-cucumber.findJiraBugReferences', 'toolium-123');
  assert.equal(vscode.window.activeTextEditor.document.uri.toString(), uri.toString());
  assert.equal(vscode.window.activeTextEditor.selection.start.line, 6);
  assert.equal(document.getText(vscode.window.activeTextEditor.selection), 'TOOLIUM-123');
}

/** Verify that VS Code offers the Gherkin formatter both explicitly and on save. */
async function testFeatureFormatting(workspace) {
  const uri = await write(workspace, 'formatting/notes.feature', [
    'Feature: Keep a notebook',
    ' Scenario: Record a figure',
    '   Given a drawing',
    ' |name|',
    ' |moon|'
  ].join('\n'));
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  editor.options = { tabSize: 2, insertSpaces: true };
  await vscode.commands.executeCommand('editor.action.formatDocument');
  assert.equal(document.lineAt(1).text, '  Scenario: Record a figure');
  assert.equal(document.lineAt(3).text, '      | name |');

  const config = vscode.workspace.getConfiguration('editor', { uri, languageId: 'gherkin' });
  await config.update('formatOnSave', true, vscode.ConfigurationTarget.Workspace, true);
  assert.ok(await editor.edit((edit) => edit.delete(new vscode.Range(1, 0, 1, 1))));
  assert.ok(await document.save());
  const saved = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  assert.match(saved, /^  Scenario: Record a figure$/m);
}

/** Exercise the contributed snippet and native Enter rules in a Gherkin editor. */
async function testFeatureWriting(workspace) {
  const uri = await write(workspace, 'writing/notes.feature', [
    'Feature: View the sky',
    '  Actions Before the Feature:',
    '    Setup a notebook',
    '  Scenario: Observe a figure',
    '    Given a description',
    '      """',
    '      Scenario: Literal documentation',
    '      """',
    '  '
  ].join('\n'));
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  editor.options = { tabSize: 2, insertSpaces: true };
  editor.selection = new vscode.Selection(8, 2, 8, 2);
  await vscode.commands.executeCommand('editor.action.insertSnippet', { langId: 'gherkin', name: 'Scenario Outline' });
  assert.equal(document.lineAt(8).text, '  Scenario Outline: Outline name');
  assert.equal(document.lineAt(13).text, '    Examples:');
  await vscode.commands.executeCommand('jumpToNextSnippetPlaceholder');
  await vscode.commands.executeCommand('jumpToNextSnippetPlaceholder');
  await vscode.commands.executeCommand('type', { text: 'constellation' });
  assert.match(document.lineAt(9).text, /<constellation>/);
  assert.equal(document.lineAt(14).text, '      | constellation |');
  await vscode.commands.executeCommand('leaveSnippet');

  const docString = document.lineAt(6).range.end;
  editor.selection = new vscode.Selection(docString, docString);
  await vscode.commands.executeCommand('type', { text: '\n' });
  assert.equal(editor.selection.active.character, 6);

  for (const [line, width] of [[3, 4], [1, 4], [0, 2]]) {
    const end = document.lineAt(line).range.end;
    editor.selection = new vscode.Selection(end, end);
    await vscode.commands.executeCommand('type', { text: '\n' });
    assert.equal(editor.selection.active.character, width);
  }

  const localized = await write(workspace, 'writing/localized.feature', '# language: es\nCaracterística: Observation\n  Escenario: Record a figure');
  const localizedDocument = await vscode.workspace.openTextDocument(localized);
  const localizedEditor = await vscode.window.showTextDocument(localizedDocument);
  localizedEditor.options = { tabSize: 4, insertSpaces: false };
  const end = localizedDocument.lineAt(2).range.end;
  localizedEditor.selection = new vscode.Selection(end, end);
  await vscode.commands.executeCommand('type', { text: '\n' });
  assert.equal(localizedDocument.lineAt(3).text, '\t');
}

/** Report the test outcome to the launcher, including when VS Code starts asynchronously. */
exports.run = async function () {
  const workspace = vscode.workspace.workspaceFolders[0].uri;
  try {
    await testPythonCompletion(workspace);
    await testFeatureDiagnostics(workspace);
    await testResourceNavigation(workspace);
    await testJiraSummary(workspace);
    await testJiraBugSearch(workspace);
    await testFeatureFormatting(workspace);
    await testFeatureWriting(workspace);
    await write(workspace, '.passed', 'passed\n');
  } catch (error) {
    await write(workspace, '.failed', error.stack ?? String(error));
    throw error;
  }
};
