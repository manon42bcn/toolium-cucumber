const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { featureSections, parseFeature } = require('../out/feature');
const grammar = require('../syntaxes/gherkin.tmLanguage.json');

const source = readFileSync(join(__dirname, 'fixtures', 'observatory.feature'), 'utf8');

test('parses an outline with a doc string, table and examples', () => {
  const { document, issues } = parseFeature(source);
  assert.deepEqual(issues, []);
  assert.equal(document.feature.language, 'en');
  const rule = document.feature.children[0].rule;
  assert.equal(rule.children[0].background.steps.length, 1);
  const scenario = rule.children[1].scenario;
  assert.equal(scenario.steps[0].docString.content, 'Diagram of <figure>');
  assert.equal(scenario.steps[1].dataTable.rows[1].cells[1].value, '<figure>');
  assert.equal(scenario.examples[0].tableBody[0].cells[0].value, 'Spiral');
});

test('builds nested sections with header positions and bounded ranges', () => {
  const lines = source.split('\n');
  const { document } = parseFeature(lines.join('\r\n'));
  const [feature] = featureSections(document.feature, lines);
  const [rule] = feature.children;
  const [background, scenario] = rule.children;
  const [examples] = scenario.children;
  assert.equal(feature.startLine, 1);
  assert.equal(feature.line, 2);
  assert.equal(background.endLine, background.line + 1);
  assert.equal(scenario.startLine, scenario.line - 1);
  assert.equal(scenario.column, 4);
  assert.equal(scenario.endLine, examples.endLine);
  assert.equal(feature.endLine, lines.length - 2);
});

test('reports invalid dialects and unterminated doc strings with locations', () => {
  const invalidLanguage = parseFeature('# language: zz\nFeature: A notebook');
  assert.match(invalidLanguage.issues[0].message, /Language not supported/);
  assert.equal(invalidLanguage.issues[0].line, 0);

  const incomplete = parseFeature('Feature: A notebook\nScenario: A mark\nGiven a drawing\n"""\nA circle');
  assert.equal(incomplete.document, undefined);
  assert.match(incomplete.issues[0].message, /unexpected end of file/);
  assert.equal(incomplete.issues[0].line, 5);
});

test('accepts an empty feature file while editing', () => {
  const { document, issues } = parseFeature('');
  assert.deepEqual(issues, []);
  assert.equal(document.feature, undefined);
});

test('marks each placeholder tag on a localized regular scenario at its exact range', () => {
  const lines = [
    '# language: es',
    'Característica: Notebook',
    '  @manual @<figure> @record.new:type:<name> @verified',
    '  Escenario: One note',
    '    Dado an empty notebook',
    '  @record:<figure>',
    '  Esquema del escenario: Multiple notes',
    '    Dado a drawing of <figure>',
    '    Ejemplos:',
    '      | figure |',
    '      | Moon   |'
  ];
  const { document, issues } = parseFeature(lines.join('\n'));
  assert.deepEqual(issues, []);
  const [regular, outline] = featureSections(document.feature, lines)[0].children;
  assert.deepEqual(regular.tagIssues.map(({ line, column, length }) => [
    line, lines[line].slice(column, column + length)
  ]), [
    [2, '@<figure>'],
    [2, '@record.new:type:<name>']
  ]);
  assert.deepEqual(outline.tagIssues, []);
});

test('retains each inherited tag origin and scopes Examples tags to their own block', () => {
  const lines = [
    '@notebook',
    'Feature: A notebook',
    '  @astronomy',
    '  Rule: A drawing describes an object',
    '    @sketch',
    '    Scenario Outline: Draw a figure',
    '      Given a drawing of <figure>',
    '      @night',
    '      Examples: Night',
    '        | figure |',
    '        | Moon   |',
    '      Examples: Day',
    '        | figure |',
    '        | Sun    |'
  ];
  const { document, issues } = parseFeature(lines.join('\n'));
  assert.deepEqual(issues, []);
  const [feature] = featureSections(document.feature, lines);
  const [outline] = feature.children[0].children;
  const [night, day] = outline.children;
  assert.deepEqual(night.tags.map(({ name, originLine }) => [name, originLine]), [
    ['@notebook', 1],
    ['@astronomy', 3],
    ['@sketch', 5],
    ['@night', 8]
  ]);
  assert.deepEqual(day.tags, outline.tags);
});

test('generates heading and step patterns from multiple dialects', () => {
  const heading = new RegExp(grammar.patterns.find((pattern) =>
    pattern.captures?.[1]?.name === 'keyword.control.gherkin').match);
  const step = new RegExp(grammar.patterns.find((pattern) =>
    pattern.captures?.[1]?.name === 'keyword.other.step.gherkin').match);

  assert.equal(heading.exec('  Esquema del escenario: Record')[1], 'Esquema del escenario:');
  assert.equal(heading.exec('機能: Observe stars')[1], '機能:');
  assert.equal(step.exec('  * a mark')[1], '* ');
  assert.equal(step.exec('  Entonces the notebook')[1], 'Entonces ');
  assert.equal(step.exec('  GivenName'), null);
});
