import { parseFeature } from './feature';

type GherkinDocument = NonNullable<ReturnType<typeof parseFeature>['document']>;
type Feature = NonNullable<GherkinDocument['feature']>;
type FeatureChild = Feature['children'][number];
type Rule = NonNullable<FeatureChild['rule']>;
type Scenario = NonNullable<FeatureChild['scenario']>;
type Step = Scenario['steps'][number];
type Examples = Scenario['examples'][number];
type TableRow = NonNullable<Examples['tableHeader']>;
type Section = Feature | Rule | Scenario | NonNullable<FeatureChild['background']> | Examples;

interface FeatureLineEdit {
  line: number;
  text: string;
}

/** Remove only standard indentation, preserving the remainder of the source line. */
function withoutIndent(line: string): string {
  return line.replace(/^[ \t]*/, '');
}

/** Split a raw table row at unescaped pipes without decoding any cell contents. */
function rawCells(line: string): string[] | undefined {
  const text = line.trim();
  if (!text.startsWith('|')) {
    return;
  }
  const cells: string[] = [];
  let start = 1;
  for (let index = start; index < text.length; index++) {
    if (text[index] === '\\') {
      index++;
    } else if (text[index] === '|') {
      // Match Gherkin's table trimming rules. Line breaks can be escaped cell content.
      cells.push(text.slice(start, index).replace(/^[ \t\v\f\r\u0085\u00a0]+|[ \t\v\f\r\u0085\u00a0]+$/g, ''));
      start = index + 1;
    }
  }
  return start === text.length ? cells : undefined;
}

/** Compare document content and hierarchy independently of parser IDs and source coordinates. */
function semanticDocument(document: GherkinDocument): string {
  return JSON.stringify(document, (key, value) => key === 'id' || key === 'location' ? undefined : value);
}

/** Reindent parsed features and align their tables using the editor's indentation unit. */
export function formatFeature(source: string, indent: string): FeatureLineEdit[] {
  const { document } = parseFeature(source);
  if (!document?.feature) {
    return [];
  }

  const separated = source.split(/(\r\n|\r|\n)/);
  const lines = separated.filter((_, index) => index % 2 === 0);
  const edits = new Map<number, string>();

  /** Set the indentation of a structural line without changing its content. */
  function reindent(line: number, depth: number): void {
    edits.set(line, indent.repeat(depth) + withoutIndent(lines[line]));
  }

  /** Align columns within one table, retaining their raw Gherkin escapes. */
  function alignTable(rows: readonly TableRow[], depth: number): void {
    const raw = rows.map((row) => rawCells(lines[row.location.line - 1]));
    if (!raw.length || raw.some((cells, index) => cells?.length !== rows[index].cells.length)) {
      return;
    }
    const widths = Array<number>(rows[0].cells.length).fill(0);
    for (const cells of raw) {
      cells?.forEach((cell, index) => {
        widths[index] = Math.max(widths[index], Array.from(cell).length);
      });
    }
    rows.forEach((row, index) => {
      const cells = raw[index] ?? [];
      const text = cells.map((cell, column) => cell + ' '.repeat(widths[column] - Array.from(cell).length));
      edits.set(row.location.line - 1, indent.repeat(depth) + '| ' + text.join(' | ') + ' |');
    });
  }

  /** Shift a doc string with its delimiters while preserving the indentation of its decoded content. */
  function alignDocString(docString: NonNullable<Step['docString']>, depth: number): void {
    const start = docString.location.line - 1;
    let finish = start + 1;
    while (finish < lines.length && !lines[finish].trimStart().startsWith(docString.delimiter)) {
      finish++;
    }
    if (finish === lines.length) {
      return;
    }
    const originalIndent = lines[start].length - withoutIndent(lines[start]).length;
    reindent(start, depth);
    reindent(finish, depth);
    for (let line = start + 1; line < finish; line++) {
      if (lines[line].length) {
        const leading = lines[line].length - withoutIndent(lines[line]).length;
        edits.set(line, indent.repeat(depth) + lines[line].slice(Math.min(originalIndent, leading)));
      }
    }
  }

  /** Visit a Gherkin section and assign depths to its headings, tags, steps, and arguments. */
  function visit(section: Section, depth: number): void {
    reindent(section.location.line - 1, depth);
    if ('tags' in section) {
      section.tags.forEach((tag) => reindent(tag.location.line - 1, depth));
    }
    if ('children' in section) {
      for (const child of section.children) {
        const nested = child.scenario ?? child.background ?? ('rule' in child ? child.rule : undefined);
        if (nested) {
          visit(nested, depth + 1);
        }
      }
    } else if ('steps' in section) {
      for (const step of section.steps) {
        reindent(step.location.line - 1, depth + 1);
        if (step.dataTable) {
          alignTable(step.dataTable.rows, depth + 2);
        }
        if (step.docString) {
          alignDocString(step.docString, depth + 2);
        }
      }
      if ('examples' in section) {
        section.examples.forEach((examples) => visit(examples, depth + 1));
      }
    } else if (section.tableHeader) {
      alignTable([section.tableHeader, ...section.tableBody], depth + 1);
    }
  }

  visit(document.feature, 0);
  const changes = [...edits].filter(([line, text]) => lines[line] !== text).sort(([a], [b]) => a - b);
  if (!changes.length) {
    return [];
  }
  for (const [line, text] of changes) {
    separated[line * 2] = text;
  }
  // Reparse before requesting edits so unfamiliar syntax cannot silently change the feature's meaning.
  const formatted = parseFeature(separated.join('')).document;
  if (!formatted || semanticDocument(document) !== semanticDocument(formatted)) {
    return [];
  }
  return changes.map(([line, text]) => ({ line, text }));
}
