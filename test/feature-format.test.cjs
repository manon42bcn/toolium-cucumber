const assert = require('node:assert/strict');
const { test } = require('node:test');
const { formatFeature } = require('../out/feature-format');

/** Apply formatter line edits while retaining the source line endings. */
function apply(source, indent) {
  const parts = source.split(/(\r\n|\r|\n)/);
  for (const { line, text } of formatFeature(source, indent)) {
    parts[line * 2] = text;
  }
  return parts.join('');
}

test('formats localized structural lines and aligns both table types while retaining raw escapes', () => {
  const lines = [
    '# language: es',
    '  @observatory',
    '  Característica: Observation log',
    ' Regla: Use a notebook',
    ' @record',
    ' Esquema del escenario: Register a sample',
    '   Dado the sample name <name>',
    String.raw` | value | note |`,
    String.raw` | a\|b | line\nnext |`,
    ' # Keep this comment exactly where it is.',
    ' Ejemplos: Names',
    ' |name|color|',
    ' | moon | blue |',
    ' | comet | |',
    ''
  ];
  const source = lines.join('\r\n');
  const expected = [
    '# language: es',
    '@observatory',
    'Característica: Observation log',
    '  Regla: Use a notebook',
    '    @record',
    '    Esquema del escenario: Register a sample',
    '      Dado the sample name <name>',
    String.raw`        | value | note       |`,
    String.raw`        | a\|b  | line\nnext |`,
    ' # Keep this comment exactly where it is.',
    '      Ejemplos: Names',
    '        | name  | color |',
    '        | moon  | blue  |',
    '        | comet |       |',
    ''
  ].join('\r\n');
  assert.equal(apply(source, '  '), expected);
  assert.deepEqual(formatFeature(expected, '  '), []);
});

test('preserves Toolium action text and shifts a scenario doc string without changing its content', () => {
  const source = [
    'Feature: Examine the sky',
    '  Actions Before the Feature:',
    '       Setup an empty notebook',
    '         | original | layout |',
    ' Scenario: Write an entry',
    '   Given a notebook',
    '   Then the following note is saved',
    '   """text/plain',
    '   First line',
    '     Indented line',
    '',
    '   """',
    ''
  ].join('\n');
  const actual = apply(source, '\t');
  assert.equal(actual, [
    'Feature: Examine the sky',
    '  Actions Before the Feature:',
    '       Setup an empty notebook',
    '         | original | layout |',
    '\tScenario: Write an entry',
    '\t\tGiven a notebook',
    '\t\tThen the following note is saved',
    '\t\t\t"""text/plain',
    '\t\t\tFirst line',
    '\t\t\t  Indented line',
    '',
    '\t\t\t"""',
    ''
  ].join('\n'));
  assert.deepEqual(formatFeature(actual, '\t'), []);
});

test('leaves invalid or empty features untouched', () => {
  assert.deepEqual(formatFeature('', '  '), []);
  assert.deepEqual(formatFeature('Feature: Notes\n Scenario: Record a note\n Given a note\n """\n text', '  '), []);
});
