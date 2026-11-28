const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { resolve } = require('node:path');
const { loadWithVscode, uri } = require('./resources/helpers/vscode');

/** Wait for the view to process a simulated formatter flush. */
async function waitForHtml(panel, pattern) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (pattern.test(panel.webview.html)) {
      return;
    }
    await delay(30);
  }
  assert.match(panel.webview.html, pattern);
}

test('follows a running step and retains partial results when the user cancels the launch', async () => {
  let trackerFactory, terminate;
  let output = '{"event":"runStarted","version":1}\n{"event":"runFinished"}\n';
  const panel = { webview: {}, onDidDispose() {}, reveal() {}, dispose() {} };
  const vscode = {
    Uri: { file: uri },
    ViewColumn: { Beside: -2 },
    Disposable: class {
      /** Store the cleanup hook supplied by the view. */
      constructor(dispose) { this.dispose = dispose; }
    },
    window: { createWebviewPanel: () => panel },
    commands: { registerCommand: () => ({}) },
    debug: {
      registerDebugAdapterTrackerFactory: (_, factory) => { trackerFactory = factory; return {}; },
      onDidTerminateDebugSession: (handler) => { terminate = handler; return {}; }
    },
    workspace: { fs: {
      stat: async () => ({ mtime: 1, size: Buffer.byteLength(output) }),
      readFile: async () => Buffer.from(output)
    } }
  };
  const context = { subscriptions: [] };
  const { registerScenarioResultsView } = loadWithVscode('../scenario-results-view', vscode);
  registerScenarioResultsView(context);
  const session = { id: 'synthetic', configuration: {
    module: 'behave',
    cwd: resolve('invented'),
    args: ['-f', 'toolium_cucumber_results:ResultsFormatter', '-o', 'results.jsonl']
  } };
  try {
    const tracker = trackerFactory.createDebugAdapterTracker(session);
    tracker.onWillStartSession();
    assert.match(panel.webview.html, /Waiting for scenario results/);
    await delay(0);
    output = [
      '{"event":"runStarted","version":1}',
      '{"event":"scenarioStarted","scenarioId":1,"name":"Watch the sky"}',
      '{"event":"step","scenarioId":1,"stepId":1,"keyword":"When","name":"I wait"}',
      '{"event":"stepStarted","scenarioId":1,"stepId":1}',
      ''
    ].join('\n');
    await waitForHtml(panel, /class="status running"/);
    tracker.onWillReceiveMessage({ type: 'request', command: 'disconnect' });
    await terminate(session);
    assert.match(panel.webview.html, /Cancelled/);
    assert.match(panel.webview.html, /When I wait/);
    assert.doesNotMatch(panel.webview.html, /class="status running"/);
  } finally {
    for (const subscription of context.subscriptions) {
      subscription.dispose?.();
    }
  }
});
