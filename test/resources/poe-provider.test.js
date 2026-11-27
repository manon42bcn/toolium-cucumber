const { test } = require('node:test');
const assert = require('node:assert/strict');
const { uri, createVscode, loadWithVscode } = require('./helpers/vscode');

// Exercise the registered provider through a minimal VS Code API double so that
// discovery and matching across multiple files are tested together.
test('POE provider returns the same reference in multiple files and uses its configured directory', async () => {

  const first = uri('/repo/custom/poe/a.json');
  const second = uri('/repo/custom/poe/b.json');
  const opened = [];
  const patterns = [];

  const vscode = createVscode({
    RelativePattern: class { constructor(base, pattern) { patterns.push({base, pattern}); } },
    workspace: {
      getWorkspaceFolder: () => ({uri: uri('/repo')}),
      getConfiguration: () => ({ get: (name, fallback) => name === 'poeditorPaths'
        ? ['custom/poe'] : fallback }),
      findFiles: async () => [second, first, first],
      openTextDocument: async resource => {
        opened.push(resource.path);
        return {
          getText: () => '[{"term":"text","reference":"sky:chart.labels.key"}]',
          positionAt: offset => ({line: 0, character: offset}),
          getWordRangeAtPosition: () => undefined
        };
      }
    },
  });
  const provider = loadWithVscode('navigation', vscode).resolveResourceLinks;
  const links = await provider({
    uri: uri('/repo/example.feature'),
    lineAt: () => ({text: '[POE:sky:chart.labels.key]'})
  }, {line: 0, character: 10}, {isCancellationRequested: false});
  assert.deepEqual(links.map(link => link.targetUri.path), [first.path, second.path]);
  assert.equal(opened.length, 2);
  assert.equal(patterns[0].base.path, '/repo/custom/poe');
  assert.equal(patterns[0].pattern, '**/*.json');
});
