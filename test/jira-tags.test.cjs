const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseFeature, jiraStoryCleanup, jiraStorySummary } = require('../out/feature');

/** Parse an invented feature and return its Jira summary correction. */
function correction(lines) {
  const { document, issues } = parseFeature(lines.join('\n'));
  assert.deepEqual(issues, []);
  return jiraStorySummary(document.feature);
}

test('adds missing Jira stories once while retaining existing story order and extra stories', () => {
  assert.deepEqual(correction([
    '@smoke @US.ORBIT-8:ORBIT-4',
    'Feature: Track objects',
    '  @jira.ac.ORBIT-4#AC1 @jira.ac.ORBIT-2#AC1,AC3',
    '  Scenario Outline: Track a figure',
    '    Given a telescope',
    '    @jira.ac.ORBIT-2#AC2 @jira.ac.ORBIT-5#AC1',
    '    Examples:',
    '      | figure |',
    '      | moon   |'
  ]), {
    missing: ['ORBIT-2', 'ORBIT-5'], line: 0, column: 7, length: '@US.ORBIT-8:ORBIT-4'.length,
    text: '@US.ORBIT-8:ORBIT-4:ORBIT-2:ORBIT-5'
  });
});

test('inserts a missing feature summary after the dialect directive and before the feature tags', () => {
  assert.deepEqual(correction([
    '# language: en',
    '@smoke',
    'Feature: Track objects',
    '  @jira.ac.ORBIT-1#AC1',
    '  Rule: Use a telescope',
    '    Scenario: Track the moon',
    '      Given a telescope'
  ]), { missing: ['ORBIT-1'], line: 1, column: 0, length: 0, text: '@US.ORBIT-1' });
});

test('ignores dynamic references and accepts a summary that already covers the feature', () => {
  assert.equal(correction([
    '@US.ORBIT-2:ORBIT-1',
    'Feature: Track objects',
    '  @jira.ac.ORBIT-1#AC1 @jira.ac.ORBIT-2#AC1 @jira.ac.<story>#AC1',
    '  Scenario Outline: Track a figure',
    '    Given a telescope'
  ]), undefined);
});

test('cleanup drops only unreferenced summary keys without adding missing ones', () => {
  const { document, issues } = parseFeature([
    '@US.ORBIT-8:ORBIT-4 @smoke @US.ORBIT-9',
    'Feature: Track objects',
    '  @jira.ac.ORBIT-4#AC1 @jira.ac.ORBIT-2#AC2',
    '  Scenario: Observe a comet',
    '    Given a telescope'
  ].join('\n'));
  assert.deepEqual(issues, []);
  assert.deepEqual(jiraStoryCleanup(document.feature), [
    { line: 0, column: 0, length: '@US.ORBIT-8:ORBIT-4'.length, text: '@US.ORBIT-4' },
    { line: 0, column: 27, length: '@US.ORBIT-9'.length, text: '' }
  ]);
  assert.deepEqual(jiraStorySummary(document.feature).missing, ['ORBIT-2']);
});
