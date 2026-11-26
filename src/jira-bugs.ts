import { parseFeature } from './feature';

type Feature = NonNullable<NonNullable<ReturnType<typeof parseFeature>['document']>['feature']>;
type FeatureChild = Feature['children'][number];
type Rule = NonNullable<FeatureChild['rule']>;
type Scenario = NonNullable<FeatureChild['scenario']>;
type Tag = Feature['tags'][number];

const detectsPrefix = '@jira.link.detects.';
const issueIdPattern = /^([A-Z][A-Z0-9_]*)-\d+$/;

export interface JiraBugReference {
  line: number;
  column: number;
  length: number;
  label: string;
  kind: 'tag' | 'example';
}

/** Normalize configured Jira project keys, preserving an empty set when none are configured. */
export function jiraBugPrefixes(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.map((value) => value.trim().toUpperCase()).filter((value) => /^[A-Z][A-Z0-9_]*$/.test(value)));
}

/** Parse a complete Jira bug ID when its project prefix is explicitly configured. */
export function jiraBugId(value: string, prefixes: ReadonlySet<string>): string | undefined {
  const id = value.trim().toUpperCase();
  const match = issueIdPattern.exec(id);
  return match && prefixes.has(match[1]) ? id : undefined;
}

/** Build an HTTP(S) Jira issue URL from a configured template and a complete ID. */
export function jiraIssueUrl(template: string, value: string): string | undefined {
  const id = value.trim().toUpperCase();
  const source = template.trim();
  if (!issueIdPattern.test(id) || !/^https?:\/\//i.test(source) || !source.includes('(id)')) {
    return;
  }
  try {
    const url = new URL(source.replaceAll('(id)', encodeURIComponent(id)));
    return url.hostname ? url.href : undefined;
  } catch {
    return;
  }
}

/** Open a resolved URL using the preferred browser, falling back if the integrated browser is unavailable. */
export async function openJiraIssueUrl(
  url: string,
  preferIntegrated: boolean,
  openIntegrated: (url: string) => Promise<boolean>,
  openExternal: (url: string) => PromiseLike<boolean>
): Promise<boolean> {
  if (preferIntegrated) {
    try {
      if (await openIntegrated(url)) {
        return true;
      }
    } catch {
      // An older or unsupported VS Code host can reject the integrated browser command.
    }
  }
  return openExternal(url);
}

/** Find literal bug tags and the exact Examples cells referenced by dynamic tags. */
export function findJiraBugReferences(feature: Feature, id: string, prefixes: ReadonlySet<string>): JiraBugReference[] {
  const search = jiraBugId(id, prefixes);
  if (!search) {
    return [];
  }

  const matches = new Map<string, JiraBugReference>();

  /** Save a reference once even when several inherited tags point to the same cell. */
  function add(location: Tag['location'], length: number, label: string, kind: JiraBugReference['kind'], offset = 0) {
    const line = location.line - 1;
    const column = (location.column ?? 1) - 1 + offset;
    matches.set(`${line}:${column}`, { line, column, length, label, kind });
  }

  /** Read literal IDs and return the Examples column names mentioned in these tags. */
  function scanTags(tags: readonly Tag[], label: string): string[] {
    const columns = new Set<string>();
    for (const tag of tags) {
      if (!tag.name.startsWith(detectsPrefix)) {
        continue;
      }
      let offset = detectsPrefix.length;
      for (const segment of tag.name.slice(offset).split(':')) {
        const column = /^<([^<>]+)>$/.exec(segment);
        if (column) {
          columns.add(column[1]);
        } else if (jiraBugId(segment, prefixes) === search) {
          add(tag.location, segment.length, label, 'tag', offset);
        }
        offset += segment.length + 1;
      }
    }
    return [...columns];
  }

  /** Look up only the columns referenced by tags effective for the given Examples block. */
  function scanExamples(scenario: Scenario, inherited: readonly string[]): void {
    const scenarioColumns = [...inherited, ...scanTags(scenario.tags, scenario.name || scenario.keyword)];
    for (const examples of scenario.examples) {
      const label = [scenario.name || scenario.keyword, examples.name || examples.keyword].join(' · ');
      const columns = new Set([...scenarioColumns, ...scanTags(examples.tags, label)]);
      const indexes = examples.tableHeader?.cells.flatMap((cell, index) => columns.has(cell.value) ? [index] : []) ?? [];
      for (const row of examples.tableBody) {
        for (const index of indexes) {
          const cell = row.cells[index];
          if (cell && cell.value.split(':').some((value) => jiraBugId(value, prefixes) === search)) {
            add(cell.location, cell.value.length, label, 'example');
          }
        }
      }
    }
  }

  const inherited = scanTags(feature.tags, feature.name || feature.keyword);
  for (const child of feature.children) {
    if (child.scenario) {
      scanExamples(child.scenario, inherited);
    } else if (child.rule) {
      const rule: Rule = child.rule;
      const columns = [...inherited, ...scanTags(rule.tags, rule.name || rule.keyword)];
      for (const entry of rule.children) {
        if (entry.scenario) {
          scanExamples(entry.scenario, columns);
        }
      }
    }
  }
  return [...matches.values()].sort((a, b) => a.line - b.line || a.column - b.column);
}
