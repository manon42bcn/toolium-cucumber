import * as vscode from 'vscode';
import { FeatureSection, featureSections, parseFeature } from './feature';

const language = 'gherkin';
const diagnosticDelay = 200;

/** List sections in document order for tag lookups and diagnostics. */
function flattenSections(sections: FeatureSection[]): FeatureSection[] {
  return sections.flatMap((section) => [section, ...flattenSections(section.children)]);
}

/** Register Gherkin providers, commands, and document lifecycle handlers. */
export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection(language);
  const cache = new WeakMap<vscode.TextDocument, {
    version: number;
    parsed: ReturnType<typeof parseFeature>;
    sections: FeatureSection[];
    allSections: FeatureSection[];
  }>();
  const pending = new Map<vscode.TextDocument, ReturnType<typeof setTimeout>>();

  /** Reuse the analysis for the current document version across editor providers. */
  function analyze(document: vscode.TextDocument) {
    const cached = cache.get(document);
    if (cached?.version === document.version) {
      return cached;
    }

    const text = document.getText();
    const parsed = parseFeature(text);
    const feature = parsed.document?.feature;
    const sections = feature ? featureSections(feature, text.split(/\r\n|\r|\n/)) : [];
    const result = { version: document.version, parsed, sections, allSections: flattenSections(sections) };
    cache.set(document, result);
    return result;
  }

  /** Cancel any diagnostic update queued for this document. */
  function cancelValidation(document: vscode.TextDocument) {
    clearTimeout(pending.get(document));
    pending.delete(document);
  }

  /** Refresh diagnostics after edits have paused. */
  function validate(document: vscode.TextDocument) {
    if (document.languageId !== language) {
      return;
    }
    cancelValidation(document);
    pending.set(document, setTimeout(() => {
      pending.delete(document);
      const { parsed, allSections } = analyze(document);
      const issues = [...parsed.issues, ...allSections.flatMap((section) => section.tagIssues)];
      diagnostics.set(document.uri, issues.map((issue) => {
        // A parser error at EOF can point to the line after the actual document.
        const start = document.validatePosition(new vscode.Position(
          Math.max(0, Math.min(issue.line, document.lineCount - 1)),
          Math.max(0, issue.column)
        ));
        const end = issue.length === undefined
          ? document.lineAt(start.line).range.end
          : document.validatePosition(start.translate(0, issue.length));
        const range = new vscode.Range(start, end);
        const diagnostic = new vscode.Diagnostic(range, issue.message, vscode.DiagnosticSeverity.Error);
        diagnostic.source = 'Gherkin';
        return diagnostic;
      }));
    }, diagnosticDelay));
  }

  /** Convert a section and its children to Outline symbols. */
  function symbol(document: vscode.TextDocument, section: FeatureSection): vscode.DocumentSymbol {
    const header = document.lineAt(section.line).range.with({
      start: new vscode.Position(section.line, section.column)
    });
    const range = new vscode.Range(
      document.lineAt(section.startLine).range.start,
      document.lineAt(section.endLine).range.end
    );
    const result = new vscode.DocumentSymbol(
      section.name || section.keyword,
      section.name ? section.keyword : '',
      section.children.length ? vscode.SymbolKind.Namespace : vscode.SymbolKind.Method,
      range,
      header
    );
    result.children = section.children.map((child) => symbol(document, child));
    return result;
  }

  /** Return foldable section ranges with each heading left visible. */
  function folds(sections: FeatureSection[]): vscode.FoldingRange[] {
    return sections.flatMap((section) => [
      ...(section.endLine > section.line ? [new vscode.FoldingRange(section.line, section.endLine)] : []),
      ...folds(section.children)
    ]);
  }

  /** Prompt for a tag and jump to a matching section in the current feature. */
  async function findByTag() {
    const document = vscode.window.activeTextEditor?.document;
    if (document?.languageId !== language) {
      return;
    }

    const { allSections, version } = analyze(document);
    const tags = [...new Set(allSections.flatMap((section) => section.tags.map((tag) => tag.name)))].sort();
    if (!tags.length) {
      vscode.window.setStatusBarMessage('No Gherkin tags found in this feature.', 3000);
      return;
    }

    const tag = await vscode.window.showQuickPick(tags, { placeHolder: 'Select a Gherkin tag' });
    // The stored coordinates only apply to the version used to populate the picker.
    if (!tag || document.isClosed || document.version !== version) {
      return;
    }

    const sections = allSections
      .filter((section) => section.tags.some((entry) => entry.name === tag))
      .map((section) => ({
        label: section.name || section.keyword,
        description: `${section.keyword} · Line ${section.line + 1}`,
        section
      }));
    const selected = await vscode.window.showQuickPick(sections, { placeHolder: `Sections with ${tag}` });
    if (selected && !document.isClosed && document.version === version) {
      const { line, column } = selected.section;
      const position = new vscode.Position(line, column);
      await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
    }
  }

  context.subscriptions.push(
    diagnostics,
    new vscode.Disposable(() => pending.forEach((timer) => clearTimeout(timer))),
    vscode.workspace.onDidOpenTextDocument(validate),
    vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
      if (contentChanges.length) {
        validate(document);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      cancelValidation(document);
      cache.delete(document);
      diagnostics.delete(document.uri);
    }),
    vscode.languages.registerDocumentSymbolProvider(language, {
      /** Expose the cached section hierarchy to the Outline view. */
      provideDocumentSymbols: (document) => analyze(document).sections.map((section) => symbol(document, section))
    }),
    vscode.languages.registerFoldingRangeProvider(language, {
      /** Expose foldable Gherkin sections to the editor. */
      provideFoldingRanges: (document) => folds(analyze(document).sections)
    }),
    vscode.languages.registerHoverProvider(language, {
      /** Show each effective tag and its declaration origin over a section heading. */
      provideHover(document, position) {
        const section = analyze(document).allSections.find((entry) => entry.line === position.line);
        if (!section?.tags.length || position.character < section.column) {
          return;
        }

        const contents = new vscode.MarkdownString('**Effective tags**\n\n');
        for (const tag of section.tags) {
          contents.appendMarkdown('- ');
          const origin = tag.originLine === section.line ? 'Declared here' : `Inherited from ${tag.originLabel}`;
          contents.appendText(`${tag.name} · ${origin}`);
          contents.appendMarkdown('\n');
        }
        return new vscode.Hover(contents, document.lineAt(section.line).range);
      }
    }),
    vscode.commands.registerCommand('toolium-cucumber.findByTag', findByTag)
  );
  vscode.workspace.textDocuments.forEach(validate);
}
