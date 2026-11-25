import { AstBuilder, dialects, Errors, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';

type Feature = NonNullable<ReturnType<ReturnType<typeof makeParser>['parse']>['feature']>;
type FeatureChild = Feature['children'][number];
type Rule = NonNullable<FeatureChild['rule']>;
type Scenario = NonNullable<FeatureChild['scenario']>;
type Background = NonNullable<FeatureChild['background']>;
type Section = Feature | Rule | Scenario | NonNullable<FeatureChild['background']> | Scenario['examples'][number];

export interface StepQuery {
  kind: 'given' | 'when' | 'then' | 'step';
  text: string;
}

interface StepCompletionContext {
  kind: StepQuery['kind'];
  prefix: string;
  start: number;
  separator: string;
}

const actionHeading = /^Actions (?:Before the Feature|After the Feature|Before Each Scenario|After Each Scenario)\s*:\s*$/i;
const actionStep = /^(?:Setup|Check|Given|When|Then|And|But)\s+(.+)$/;

/** Identify the step body being edited, including an otherwise incomplete keyword line. */
export function stepCompletionContext(source: string, line: number, column: number): StepCompletionContext | undefined {
  const lines = source.split(/\r\n|\r|\n/);
  const current = lines[line];
  const indent = current.length - current.trimStart().length;
  const text = current.slice(indent);
  const firstContent = lines.findIndex((entry) => entry.trim() && !entry.trimStart().startsWith('#'));
  const leadingComments = firstContent < 0 ? lines : lines.slice(0, firstContent);
  const dialectName = /^\s*#\s*language\s*:\s*([\w-]+)\s*$/m.exec(leadingComments.join('\n'))?.[1] ?? 'en';
  const dialect = dialects[dialectName];
  if (!dialect) {
    return;
  }
  const keywords = [...new Set([...dialect.given, ...dialect.when, ...dialect.then, ...dialect.and, ...dialect.but,
    'Setup ', 'Check '])].sort((a, b) => b.length - a.length);
  const keyword = keywords.find((candidate) => text.startsWith(candidate) || text === candidate.trimEnd());
  if (!keyword) {
    return;
  }
  const head = keyword.trimEnd();
  const start = indent + head.length + (/^[ \t]*/.exec(text.slice(head.length))?.[0].length ?? 0);
  if (column < start) {
    return;
  }
  const separator = keyword !== head && start === indent + head.length ? ' ' : '';

  // Parse through the current line so unrelated unfinished blocks below it do not suppress suggestions.
  lines[line] = current.slice(0, start) + separator + 'step completion probe';
  const probe = lines.slice(0, line + 1).join('\n');
  const feature = parseFeature(probe).document?.feature;
  if (!feature) {
    return;
  }
  const query = stepQueries(feature, line)[0] ?? actionStepQuery(feature, probe, line)[0];
  if (query) {
    return { kind: query.kind, prefix: current.slice(start, column), start, separator };
  }
}

/** Resolve a step in a Toolium action block embedded in the feature description. */
export function actionStepQuery(feature: Feature, source: string, line: number): StepQuery[] {
  const firstChild = feature.children[0];
  const firstSection = firstChild?.background ?? firstChild?.rule ?? firstChild?.scenario;
  if (firstSection && line >= firstLine(firstSection)) {
    return [];
  }

  const lines = source.split(/\r\n|\r|\n/);
  let inActions = false;
  let quote = '';
  for (let index = feature.location.line; index <= line; index++) {
    const text = lines[index].trim();
    if (quote) {
      if (text.endsWith(quote)) {
        quote = '';
      }
    } else if (actionHeading.test(text)) {
      inActions = true;
    } else if (inActions && text && !text.startsWith('#') && !text.startsWith('|')) {
      if (text.startsWith('"""') || text.startsWith("'''")) {
        quote = text.slice(0, 3);
        continue;
      }
      const match = actionStep.exec(text);
      if (!match) {
        inActions = false;
      } else if (index === line) {
        // Toolium submits each action independently as a Given step.
        return [{ kind: 'given', text: match[1] }];
      }
    }
  }
  return [];
}

/** Parse an execute_steps literal as an English Gherkin scenario and look up its selected line. */
export function snippetStepQueries(text: string, line: number): StepQuery[] {
  const feature = parseFeature(`Feature: Steps\nScenario: Inline steps\n${text}`).document?.feature;
  const scenario = feature?.children[0]?.scenario;
  if (!feature || feature.children.length !== 1 || !scenario || scenario.description || scenario.examples.length) {
    return [];
  }
  return stepQueries(feature, line + 2).filter((query) => query.kind !== 'step');
}

/** Resolve a primary keyword, a Behave wildcard, or a conjunction's inherited kind. */
function stepKind(step: Scenario['steps'][number], previous: StepQuery['kind'], background: StepQuery['kind']): StepQuery['kind'] {
  switch (step.keywordType) {
    case 'Context': return 'given';
    case 'Action': return 'when';
    case 'Outcome': return 'then';
    case 'Conjunction': return previous === 'step' ? background : previous;
    default: return step.keyword.trim() === '*' && previous === 'step' ? 'given' : previous;
  }
}

/** Locate the step on the given line and expand its text for each Examples row. */
export function stepQueries(feature: Feature, line: number): StepQuery[] {
  /** Search a single scenario or background, carrying forward its last step kind. */
  function findStep(section: Scenario | Background, background: StepQuery['kind']): StepQuery[] {
    let kind: StepQuery['kind'] = 'step';
    for (const step of section.steps) {
      kind = stepKind(step, kind, background);
      if (step.location.line !== line + 1) {
        continue;
      }

      const texts = new Set<string>();
      if ('examples' in section && /<[^<>]+>/.test(step.text)) {
        for (const examples of section.examples) {
          if (!examples.tableHeader) {
            continue;
          }
          for (const row of examples.tableBody) {
            const values = new Map(examples.tableHeader.cells.map((cell, index) => [
              cell.value, row.cells[index]?.value
            ]));
            texts.add(step.text.replace(/<([^<>]+)>/g, (token, name) => values.get(name) ?? token));
          }
        }
      }
      if (!texts.size) {
        texts.add(step.text);
      }
      return [...texts].map((text) => ({ kind, text }));
    }
    return [];
  }

  /** Search direct feature children and the steps nested under any Rule. */
  function visit(children: Feature['children'] | Rule['children'], inherited: StepQuery['kind']): StepQuery[] {
    let background = inherited;
    for (const child of children) {
      const section = child.scenario ?? child.background;
      const queries = section
        ? findStep(section, background)
        : ('rule' in child && child.rule ? visit(child.rule.children, background) : []);
      if (queries.length) {
        return queries;
      }
      if (child.background?.steps.length) {
        const last = child.background.steps.reduce<StepQuery['kind']>(
          (previous, step) => stepKind(step, previous, background), 'step');
        background = last;
      }
    }
    return [];
  }

  return visit(feature.children, 'step');
}

interface FeatureTag {
  name: string;
  line: number;
  column: number;
  originLine: number;
  originLabel: string;
}

export interface FeatureIssue {
  line: number;
  column: number;
  length?: number;
  message: string;
}

export interface FeatureSection {
  name: string;
  keyword: string;
  line: number;
  column: number;
  startLine: number;
  endLine: number;
  tags: readonly FeatureTag[];
  tagIssues: FeatureIssue[];
  children: FeatureSection[];
}

/** Create a parser with fresh matcher state and document-local node IDs. */
function makeParser() {
  let id = 0;
  return new Parser(new AstBuilder(() => String(id++)), new GherkinClassicTokenMatcher());
}

/** Parse a Gherkin document and return syntax issues at zero-based positions. */
export function parseFeature(source: string): {
  document: ReturnType<ReturnType<typeof makeParser>['parse']> | undefined;
  issues: FeatureIssue[];
} {
  const parser = makeParser();
  try {
    return { document: parser.parse(source), issues: [] };
  } catch (error) {
    if (!(error instanceof Errors.GherkinException)) {
      throw error;
    }

    const errors = error instanceof Errors.CompositeParserException ? error.errors : [error];
    const issues = errors.map((entry) => {
      const location = entry instanceof Errors.GherkinException ? entry.location : undefined;
      return {
        line: (location?.line ?? 1) - 1,
        column: (location?.column ?? 1) - 1,
        message: entry.message.replace(/^\(-?\d+:-?\d+\): /, '')
      };
    });
    return { document: undefined, issues };
  }
}

/** Return the first line of a section, including any leading tags. */
function firstLine(section: Section): number {
  const tag = 'tags' in section ? section.tags[0] : undefined;
  return (tag ?? section).location.line - 1;
}

/** Build the section hierarchy with editor ranges, effective tags, and tag diagnostics. */
export function featureSections(feature: Feature, lines: readonly string[]): FeatureSection[] {
  // Both scenario forms share an AST node type. The dialect distinguishes them even before Examples is added.
  const outlineKeywords = dialects[feature.language].scenarioOutline;

  /** Build sibling sections within their parent range and pass inherited tags to descendants. */
  function build(sections: readonly Section[], end: number, inherited: readonly FeatureTag[]): FeatureSection[] {
    return sections.map((section, index) => {
      const next = sections[index + 1];
      const line = section.location.line - 1;
      // End before the next sibling's tags so folding preserves its full declaration.
      let endLine = next ? firstLine(next) - 1 : end;
      while (endLine > line && !lines[endLine].trim()) {
        endLine--;
      }

      let children: readonly Section[] = [];
      if ('children' in section) {
        children = section.children.flatMap((child) => [
          ...('rule' in child && child.rule ? [child.rule] : []),
          ...(child.background ? [child.background] : []),
          ...(child.scenario ? [child.scenario] : [])
        ]);
      } else if ('examples' in section) {
        children = section.examples;
      }

      const ownTags = 'tags' in section ? section.tags.map((tag) => ({
        name: tag.name,
        line: tag.location.line - 1,
        column: (tag.location.column ?? 1) - 1,
        originLine: line,
        originLabel: section.name ? `${section.keyword}: ${section.name}` : section.keyword
      })) : [];
      // Inherit only from ancestors so an Examples tag applies to its own block.
      const tags = 'tags' in section ? [...inherited, ...ownTags] : [];
      const tagIssues = 'examples' in section && !outlineKeywords.includes(section.keyword)
        ? ownTags.filter((tag) => /<[^<>\s]+>/.test(tag.name)).map((tag) => ({
          line: tag.line,
          column: tag.column,
          length: tag.name.length,
          message: 'Tags with <placeholders> require a Scenario Outline.'
        }))
        : [];

      return {
        name: section.name,
        keyword: section.keyword,
        line,
        column: (section.location.column ?? 1) - 1,
        startLine: firstLine(section),
        endLine,
        tags,
        tagIssues,
        children: build(children, endLine, tags)
      };
    });
  }

  return build([feature], lines.length - 1, []);
}
