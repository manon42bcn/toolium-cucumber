const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseFeature } = require('../out/feature');
const { findJiraBugReferences, jiraBugId, jiraBugPrefixes, jiraIssueUrl, openJiraIssueUrl } = require('../out/jira-bugs');

const prefixes = jiraBugPrefixes(['toolium']);
const lines = [
  'Feature: Track an observation',
  '  @jira.link.detects.TOOLIUM-42:<bug_id> @jira.link.detects.<bug_id>',
  '  Scenario Outline: Record a sample',
  '    Given a sample',
  '    Examples: Recorded',
  '      | bug_id       | other        |',
  '      | TOOLIUM-123  | TOOLIUM-900  |',
  '      | TOOLIUM-1234 | TOOLIUM-123  |',
  '      |              | TOOLIUM-123  |',
  '    @jira.link.detects.<linked>',
  '    Examples: Imported',
  '      | bug_id       | linked       |',
  '      |              | TOOLIUM-123  |',
  '  @jira.ac.TOOLIUM-123#AC1 @jira.link.blocks.TOOLIUM-123',
  '  Scenario: Ignore other tag types',
  '    Given a sample'
];
const { document } = parseFeature(lines.join('\n'));

/** Return the matching source ranges as line numbers and their literal text. */
function matches(id, configured = prefixes) {
  return findJiraBugReferences(document.feature, id, configured).map(({ line, column, length, kind }) => [
    line, lines[line].slice(column, column + length), kind
  ]);
}

test('uses only explicitly configured Jira prefixes and complete issue IDs', () => {
  assert.equal(jiraBugId('toolium-123', prefixes), 'TOOLIUM-123');
  assert.equal(jiraBugId('TOOLIUM-123 extra', prefixes), undefined);
  assert.equal(jiraBugId('TOOLIUM-123', jiraBugPrefixes([])), undefined);
  assert.deepEqual(matches('TOOLIUM-123', jiraBugPrefixes([])), []);
});

test('finds literal tag segments and only the Examples cells referenced by the applicable tags', () => {
  assert.deepEqual(matches('TOOLIUM-42'), [[1, 'TOOLIUM-42', 'tag']]);
  assert.deepEqual(matches('TOOLIUM-123'), [
    [6, 'TOOLIUM-123', 'example'],
    [12, 'TOOLIUM-123', 'example']
  ]);
  assert.deepEqual(matches('TOOLIUM-1234'), [[7, 'TOOLIUM-1234', 'example']]);
  assert.deepEqual(matches('TOOLIUM-900'), []);
});

test('builds a browser URL only from a valid HTTP(S) Jira issue template and complete ID', () => {
  assert.equal(jiraIssueUrl('https://jira.example.es/browse/(id)', 'toolium-123'),
    'https://jira.example.es/browse/TOOLIUM-123');
  assert.equal(jiraIssueUrl('https://jira.example.es/browse/(id)?issue=(id)', 'ORBIT-42'),
    'https://jira.example.es/browse/ORBIT-42?issue=ORBIT-42');
  assert.equal(jiraIssueUrl('https://jira.example.es/browse/(id)', 'TOOLIUM-123/other'), undefined);
  for (const template of ['', 'https://jira.example.es/browse/', 'file:///browse/(id)',
    'command:open?(id)', 'https://[invalid]/browse/(id)']) {
    assert.equal(jiraIssueUrl(template, 'TOOLIUM-123'), undefined);
  }
});

test('opens the complete Jira URL in the preferred browser and falls back when necessary', async () => {
  const url = 'https://jira.example.es/browse/TOOLIUM-123';
  for (const [preferred, integrated, expected] of [
    [false, true, ['external']],
    [true, true, ['integrated']],
    [true, false, ['integrated', 'external']],
    [true, new Error('command unavailable'), ['integrated', 'external']]
  ]) {
    const calls = [];
    const opened = await openJiraIssueUrl(url, preferred, async (address) => {
      assert.equal(address, url);
      calls.push('integrated');
      if (integrated instanceof Error) {
        throw integrated;
      }
      return integrated;
    }, async (address) => {
      assert.equal(address, url);
      calls.push('external');
      return true;
    });
    assert.equal(opened, true);
    assert.deepEqual(calls, expected);
  }
});
