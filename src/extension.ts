import * as vscode from 'vscode';
import { access } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { actionStepQuery, FeatureSection, featureSections, parseFeature, snippetStepQueries, stepQueries } from './feature';
import { StepIndex } from './step-index';

const language = 'gherkin';
const diagnosticDelay = 200;

/** List sections in document order for tag lookups and diagnostics. */
function flattenSections(sections: FeatureSection[]): FeatureSection[] {
  return sections.flatMap((section) => [section, ...flattenSections(section.children)]);
}

/** Select a configured interpreter, a nearby virtual environment, or Python on PATH. */
async function stepInterpreter(configured: string, directory: string, workspace: string): Promise<string> {
  if (configured) {
    return /[/\\]/.test(configured) ? resolve(workspace, configured) : configured;
  }

  const executable = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  for (let folder = directory; ; folder = dirname(folder)) {
    const candidate = join(folder, '.venv', ...executable);
    try {
      await access(candidate);
      return candidate;
    } catch {
      if (folder === workspace || folder === dirname(folder)) {
        break;
      }
    }
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** Register Gherkin providers, commands, and document lifecycle handlers. */
export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection(language);
  const stepIndex = new StepIndex(context.extensionPath);
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

  /** Resolve the step under the cursor and open its Python function. */
  async function goToStepDefinition(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || ![language, 'python'].includes(editor.document.languageId)) {
      return;
    }
    const { document, selection } = editor;
    const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
    if (document.uri.scheme !== 'file' || workspace?.uri.scheme !== 'file') {
      await vscode.window.showInformationMessage('Open the file in a file-based workspace to find step definitions.');
      return;
    }
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showInformationMessage('Trust this workspace to use its Python interpreter for step navigation.');
      return;
    }

    const { version } = document;
    const source = document.getText();
    const { line, character } = selection.active;
    const workspacePath = workspace.uri.fsPath;
    const config = vscode.workspace.getConfiguration('tooliumCucumber', document.uri);
    const configuredInterpreter = config.get('pythonInterpreter', '').trim();
    const importPaths = config.get<string[]>('stepImportPaths', []).map((path) => resolve(workspacePath, path));
    try {
      const sourcePath = document.uri.fsPath;
      let location: { feature: string } | { suite: string } = { feature: sourcePath };
      let interpreter = await stepInterpreter(configuredInterpreter, dirname(sourcePath), workspacePath);
      let queries;
      if (document.languageId === 'python') {
        const snippet = await stepIndex.inspectPython(interpreter, {
          workspace: workspacePath,
          path: sourcePath,
          source,
          line,
          column: Array.from(document.lineAt(line).text.slice(0, character)).length
        });
        queries = snippet ? snippetStepQueries(snippet.text, snippet.line) : [];
        if (!queries.length || !snippet) {
          await vscode.window.showInformationMessage('Place the cursor on a step inside a literal execute_steps call.');
          return;
        }

        let suite = snippet.suite;
        if (!suite) {
          const files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspace, '**/steps/*.py'), '**/{.git,.venv,venv,node_modules}/**'
          );
          const roots = [...new Set(files.map((file) => dirname(dirname(file.fsPath))))].sort();
          const suites = await stepIndex.findSuites(interpreter, {
            workspace: workspacePath, path: sourcePath, suites: roots, importPaths
          });
          if (!suites.length) {
            await vscode.window.showInformationMessage('No suite import was found for this Python module.');
            return;
          }
          suite = suites.length === 1 ? suites[0] : (await vscode.window.showQuickPick(
            suites.map((path) => ({ label: relative(workspacePath, path) || '.', path })),
            { placeHolder: 'Select a suite for this shared execute_steps call' }
          ))?.path ?? null;
          if (!suite) {
            return;
          }
        }
        location = { suite };
        interpreter = await stepInterpreter(configuredInterpreter, suite, workspacePath);
      } else {
        const feature = analyze(document).parsed.document?.feature;
        queries = feature ? stepQueries(feature, line) : [];
        if (!queries.length && feature) {
          queries = actionStepQuery(feature, source, line);
        }
        if (!queries.length) {
          await vscode.window.showInformationMessage('Place the cursor on a step in a valid feature.');
          return;
        }
      }
      if (document.isClosed || document.version !== version) {
        return;
      }
      const { suiteFound, matches } = await stepIndex.resolve(interpreter, {
        workspace: workspacePath,
        ...location,
        importPaths,
        queries
      });
      if (document.isClosed || document.version !== version) {
        return;
      }
      if (!matches.length) {
        await vscode.window.showInformationMessage(suiteFound
          ? 'No matching Python step definition was found.'
          : 'No steps directory was found above this feature.');
        return;
      }

      const selected = matches.length === 1 ? matches[0] : (await vscode.window.showQuickPick(
        matches.map((match) => {
          const localPath = relative(workspacePath, match.path);
          const displayPath = localPath.startsWith('..' + sep) ? match.path : localPath;
          return { label: match.symbol, description: `${displayPath}:${match.line + 1}`, detail: match.pattern, match };
        }),
        { placeHolder: 'Select a matching Python step definition' }
      ))?.match;
      if (selected && !document.isClosed && document.version === version) {
        const position = new vscode.Position(selected.line, 0);
        await vscode.window.showTextDocument(vscode.Uri.file(selected.path), {
          selection: new vscode.Range(position, position)
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(`Unable to open the Python step definition. ${message}`);
    }
  }

  context.subscriptions.push(
    diagnostics,
    stepIndex,
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
    vscode.commands.registerCommand('toolium-cucumber.findByTag', findByTag),
    vscode.commands.registerCommand('toolium-cucumber.goToStepDefinition', goToStepDefinition)
  );
  vscode.workspace.textDocuments.forEach(validate);
}
