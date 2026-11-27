const { test } = require('node:test');
const assert = require('node:assert/strict');
const { uri, createVscode, loadWithVscode } = require('./helpers/vscode');

/** Capture resource hover, command, and navigation calls for an invented editor. */
function fixture(text = '[LANG:screen.title]', targets = 1, sourceUri = uri('/repo/example.feature')) {
  let hover, command, selectionChanged, activeEditorChanged;
  const settings = {};
  const definitions = [], opened = [], messages = [], contexts = [];
  let searches = 0;
  const document = { uri: sourceUri, version: 1, lineCount: 1,
    languageId: 'gherkin', lineAt: () => ({ text }) };
  const vscode = createVscode({
    Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
    MarkdownString: class { constructor(value) { this.value = value; } },
    Hover: class { constructor(contents, range) { Object.assign(this, { contents, range }); } },
    ProgressLocation: { Notification: 15 },
    commands: {
      registerCommand: (id, handler) => { assert.equal(id, 'toolium-cucumber.openResource'); command = handler; return {}; },
      executeCommand: async (...args) => { contexts.push(args); }
    },
    languages: {
      registerDefinitionProvider: (selector, provider) => { definitions.push({ selector, provider }); return {}; },
      registerHoverProvider: (_, provider) => { hover = provider; return {}; }
    },
    workspace: {
      getWorkspaceFolder: () => ({ uri: uri('/repo') }),
      getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }),
      asRelativePath: target => target.path,
      findFiles: async () => { searches++; return Array.from({ length: targets }, (_, i) => uri(`/repo/${i}.yml`)); },
      openTextDocument: async () => ({ getText: () => 'screen:\n  title: Value',
        positionAt: character => ({ line: 1, character }), getWordRangeAtPosition: () => undefined })
    },
    window: {
      activeTextEditor: { document, selection: { active: { line: 0, character: 3 } } },
      onDidChangeTextEditorSelection: (handler) => { selectionChanged = handler; return {}; },
      onDidChangeActiveTextEditor: (handler) => { activeEditorChanged = handler; return {}; },
      withProgress: async (_, work) => work({}, { isCancellationRequested: false }),
      showQuickPick: async items => items[1],
      showTextDocument: async (target, options) => opened.push({ target, options }),
      showInformationMessage: message => messages.push(message),
      showErrorMessage: message => { throw Error(message); }
    }
  });
  loadWithVscode('navigation', vscode).registerResourceNavigation({ subscriptions: [] });
  return { hover, command, definitions, contexts, selectionChanged, activeEditorChanged,
    window: vscode.window, settings, opened, messages, document, searches: () => searches };
}

test('hover is lightweight for every placeholder kind and trusts only the direct command', () => {
  for (const text of ['[LANG:screen.<name>]', '[CONF:screen.title]', '[POE:screen:title]',
    '[FILE:a.txt]', '[FILE_UTF8:a.txt]', '[BASE64:a.txt]', '[TOOLIUM:Section_option]']) {
    const f = fixture(text);
    const result = f.hover.provideHover(f.document, { line: 0, character: 3 });
    assert.match(result.contents.value, /command:toolium-cucumber.openResource/);
    assert.deepEqual(result.contents.isTrusted, { enabledCommands: ['toolium-cucumber.openResource'] });
    assert.equal(f.searches(), 0);
  }
  const f = fixture('[LANG:screen.title');
  assert.equal(f.hover.provideHover(f.document, { line: 0, character: 3 }), undefined);
});

test('resource navigation does not register a definition provider', () => {
  assert.deepEqual(fixture().definitions, []);
});

test('the editor menu is available only at a Toolium resource reference', () => {
  const { contexts, window, selectionChanged, activeEditorChanged, searches } = fixture('[LANG:screen.title] plain');
  assert.deepEqual(contexts.at(-1), ['setContext', 'tooliumCucumber.hasResourceAtCursor', true]);
  const editor = window.activeTextEditor;
  editor.selection.active.character = 21;
  selectionChanged({ textEditor: editor });
  assert.equal(contexts.at(-1)[2], false);
  editor.selection.active.character = 3;
  selectionChanged({ textEditor: editor });
  assert.equal(contexts.at(-1)[2], true);
  window.activeTextEditor = undefined;
  activeEditorChanged(undefined);
  assert.equal(contexts.at(-1)[2], false);
  assert.equal(searches(), 0);
  const menu = require('../../package.json').contributes.menus['editor/context'];
  assert.equal(menu.find(({ command }) => command === 'toolium-cucumber.openResource').when,
    'tooliumCucumber.hasResourceAtCursor');
});

test('the editor menu can pass the active document URI to the resource command', async () => {
  const f = fixture();
  await f.command(uri('/repo/other.feature'));
  assert.equal(f.searches(), 0);
  await f.command(f.document.uri);
  assert.equal(f.opened[0].target.path, '/repo/0.yml');
});

test('direct command opens a single result and selects among multiple results', async () => {
  const single = fixture('LANG:screen.title');
  await single.command();
  assert.equal(single.opened[0].target.path, '/repo/0.yml');
  const multiple = fixture(undefined, 2);
  await multiple.command();
  assert.equal(multiple.opened[0].target.path, '/repo/1.yml');
});

test('hover command validates source version and placeholder before resolving', async () => {
  const f = fixture();
  const result = f.hover.provideHover(f.document, { line: 0, character: 3 });
  const encoded = result.contents.value.match(/\?([^)]*)\)/)[1];
  const [request] = JSON.parse(decodeURIComponent(encoded));
  f.document.version++;
  await f.command(request);
  assert.equal(f.searches(), 0);
  f.document.version--;
  await f.command({ ...request, text: '[LANG:other]' });
  assert.equal(f.searches(), 0);
  await f.command(request);
  assert.equal(f.opened.length, 1);
});

test('hover command preserves the source URI and placeholder through both query decodes', async () => {
  const placeholder = '[LANG:screen.title%20]';
  for (const [path, serialized] of [
    ['/c:/My Project/example#100%.feature', 'file:///c%3A/My%20Project/example%23100%25.feature'],
    ['/repo/My Project/example#100%.feature', 'file:///repo/My%20Project/example%23100%25.feature']
  ]) {
    const f = fixture(placeholder, 1, { ...uri(path), toString: () => serialized });
    const result = f.hover.provideHover(f.document, { line: 0, character: 3 });
    const encoded = result.contents.value.match(/\?([^)]*)\)/)[1];
    const [request] = JSON.parse(decodeURIComponent(decodeURIComponent(encoded)));
    assert.equal(request.uri, serialized);
    assert.equal(request.text, placeholder);
    await f.command(request);
    assert.equal(f.opened[0].target.path, '/repo/0.yml');
  }
});

test('direct command explains missing references and missing targets', async () => {
  const noReference = fixture('plain text');
  await noReference.command();
  assert.equal(noReference.searches(), 0);
  assert.equal(noReference.messages.length, 1);
  const noTarget = fixture(undefined, 0);
  await noTarget.command();
  assert.equal(noTarget.opened.length, 0);
  assert.equal(noTarget.messages.length, 1);
});
