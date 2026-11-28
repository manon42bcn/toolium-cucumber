const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readScenarioResults, scenarioResultsHtml } = require('../out/scenario-results');

test('groups outline rows by location and renders steps in declaration order as plain text', () => {
  const location = { file: 'cart.feature', line: 3 };
  const report = [
    { event: 'runStarted', version: 1 },
    { event: 'feature', name: 'Cart' },
    { event: 'scenarioStarted', scenarioId: 1, name: 'Standard', example: { name: 'Apply discount', location, rowLine: 8 } },
    { event: 'scenarioFinished', scenarioId: 1, status: 'passed' },
    { event: 'scenarioStarted', scenarioId: 2, name: 'Premium', example: { name: 'Apply discount', location, rowLine: 9 } },
    { event: 'step', scenarioId: 2, stepId: 1, keyword: 'Given', name: 'a cart' },
    { event: 'step', scenarioId: 2, stepId: 2, keyword: 'Then', name: 'the total is 80' },
    { event: 'stepFinished', scenarioId: 2, stepId: 2, status: 'failed', error: 'Expected <80> & got 90' },
    { event: 'stepFinished', scenarioId: 2, stepId: 1, status: 'passed', duration: 0.25 },
    { event: 'scenarioFinished', scenarioId: 2, status: 'failed' },
    { event: 'runFinished' }
  ].map((event) => JSON.stringify(event)).join('\n');
  const html = scenarioResultsHtml(readScenarioResults(report).scenarios);
  assert.equal(html.match(/<h2>Apply discount<\/h2>/g)?.length, 1);
  assert.match(html, /1 passed.*1 failed/);
  assert.match(html, /Examples line 8/);
  assert.match(html, /Examples line 9/);
  assert.match(html, /0\.25 s/);
  assert.match(html, /Expected &lt;80&gt; &amp; got 90/);
  assert.ok(html.indexOf('Given a cart') < html.indexOf('Then the total is 80'));
});

test('shows a running step and ignores a partial record until Behave flushes it', () => {
  const source = [
    '{"event":"runStarted","version":1}',
    '{"event":"scenarioStarted","scenarioId":1,"name":"Watch the sky"}',
    '{"event":"step","scenarioId":1,"stepId":1,"keyword":"When","name":"I wait"}',
    '{"event":"stepStarted","scenarioId":1,"stepId":1}',
    '{"event":"stepFinished"'
  ].join('\n');
  const report = readScenarioResults(source, true);
  assert.equal(report.complete, false);
  assert.match(scenarioResultsHtml(report.scenarios, 'running'), /class="status running"/);
  const cancelled = scenarioResultsHtml(report.scenarios, 'cancelled');
  assert.match(cancelled, /Cancelled/);
  assert.doesNotMatch(cancelled, /class="status running"/);
});

test('rejects incomplete or unsupported reports', () => {
  assert.throws(() => readScenarioResults('{"event":"runStarted","version":1}'), /incomplete/);
  assert.throws(() => readScenarioResults('{"event":"runStarted","version":2}\n{"event":"runFinished"}'),
    /unsupported format/);
});
