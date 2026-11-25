import { AstBuilder, dialects, Errors, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';

type Feature = NonNullable<ReturnType<ReturnType<typeof makeParser>['parse']>['feature']>;
type FeatureChild = Feature['children'][number];
type Rule = NonNullable<FeatureChild['rule']>;
type Scenario = NonNullable<FeatureChild['scenario']>;
type Section = Feature | Rule | Scenario | NonNullable<FeatureChild['background']> | Scenario['examples'][number];

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
