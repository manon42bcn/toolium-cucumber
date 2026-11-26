const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { dialects } = require('@cucumber/gherkin');

/** Build a regex alternation from unique Gherkin keywords across dialects. */
function alternatives(keys, transform = (keyword) => keyword) {
  const keywords = new Set(Object.values(dialects).flatMap((dialect) =>
    keys.flatMap((key) => dialect[key]).map(transform)
  ));
  // Prefer full keywords when one dialect's keyword is a prefix of another.
  return [...keywords]
    .sort((left, right) => right.length - left.length)
    .map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

const headings = alternatives(['feature', 'rule', 'background', 'scenarioOutline', 'scenario', 'examples']);
const actionHeadings = 'Actions (?:Before the Feature|After the Feature|Before Each Scenario|After Each Scenario)'
  .replace(/[A-Za-z]/g, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`);
const steps = alternatives(['given', 'when', 'then', 'and', 'but'], (keyword) =>
  keyword.trimEnd() + (keyword.endsWith(' ') ? ' ' : '')
).replace(/ /g, '[ \\t]+');
const parameter = { match: '<[^<>\\r\\n]+>', name: 'variable.parameter.gherkin' };

const grammar = {
  name: 'Gherkin',
  scopeName: 'source.gherkin',
  patterns: [
    { match: '^\\s*#.*$', name: 'comment.line.number-sign.gherkin' },
    {
      begin: '^\\s*("""|```).*$',
      end: '^\\s*\\1\\s*$',
      name: 'string.quoted.other.docstring.gherkin',
      patterns: [parameter]
    },
    { match: '^\\s*@.*$', captures: {
      0: { patterns: [{ match: '@[^\\s@]+', name: 'entity.name.tag.gherkin' }] }
    } },
    { match: `^\\s*((?:${headings}):)`, captures: {
      1: { name: 'keyword.control.gherkin' }
    } },
    { match: `^\\s*(${steps})`, captures: {
      1: { name: 'keyword.other.step.gherkin' }
    } },
    {
      begin: '^\\s*(?=\\|)',
      end: '$',
      name: 'meta.table.gherkin',
      patterns: [
        { match: '\\\\[|n\\\\]', name: 'constant.character.escape.gherkin' },
        { match: '\\|', name: 'punctuation.separator.table.gherkin' },
        parameter
      ]
    },
    parameter
  ]
};

const directory = join(__dirname, '..', 'syntaxes');
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'gherkin.tmLanguage.json'), JSON.stringify(grammar, null, 2) + '\n');

const languageConfiguration = JSON.parse(readFileSync(join(__dirname, '..', 'language-configuration.json'), 'utf8'));
languageConfiguration.onEnterRules = [{
  beforeText: `^[ \\t]*(?:(?:${headings}):.*|(?:${actionHeadings})[ \\t]*:)[ \\t]*$`,
  afterText: '^[ \\t]*$',
  action: { indent: 'indent' }
}];
writeFileSync(join(directory, 'gherkin.language-configuration.json'), JSON.stringify(languageConfiguration, null, 2) + '\n');
