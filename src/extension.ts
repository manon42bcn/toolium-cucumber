import * as vscode from 'vscode';
import { access } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  actionStepQuery, actionSteps, FeatureSection, featureSections, featureSteps, jiraStoryCleanup, jiraStorySummary, parseFeature,
  snippetStepQueries, stepCompletionContext, stepQueries, StepQuery
} from './feature';
import { PythonLiteral, StepDefinition, StepIndex, StepSuggestion, stepScaffold } from './step-index';
import { registerResourceNavigation } from './resources/navigation';
import { findJiraBugReferences, jiraBugId, jiraBugPrefixes, jiraIssueUrl, openJiraIssueUrl } from './jira-bugs';
import { formatFeature } from './feature-format';

const language = 'gherkin';
const diagnosticDelay = 200;
const undefinedStepCode = 'undefined-step';
const jiraStorySummaryCode = 'missing-jira-stories';
const createStepCommand = 'toolium-cucumber.createStepDefinition';
const integratedBrowserCommand = 'workbench.action.browser.open';

/** Open a URL only when the current VS Code host exposes the integrated browser. */
async function openIntegratedBrowser(url: string): Promise<boolean> {
  if (!(await vscode.commands.getCommands(true)).includes(integratedBrowserCommand)) {
    return false;
  }
  await vscode.commands.executeCommand(integratedBrowserCommand, url);
  return true;
}

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
      if (relative(workspace, folder) === '' || folder === dirname(folder)) {
        break;
      }
    }
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** Resolve settings shared by automatic step assistance and explicit navigation. */
function stepSettings(document: vscode.TextDocument, workspace: string) {
  const config = vscode.workspace.getConfiguration('tooliumCucumber', document.uri);
  return {
    configuredInterpreter: config.get('pythonInterpreter', '').trim(),
    importPaths: config.get<string[]>('stepImportPaths', []).map((path) => resolve(workspace, path))
  };
}

/** Display a definition's source with a workspace-relative path when available. */
function stepOrigin(workspace: string, definition: StepDefinition): string {
  const local = relative(workspace, definition.path);
  const path = local.startsWith('..' + sep) ? definition.path : local;
  return `${path}:${definition.line + 1}`;
}

/** Format the pattern, origin, and Python docstring as untrusted hover or completion text. */
function stepDocumentation(workspace: string, definition: StepDefinition): vscode.MarkdownString {
  const content = new vscode.MarkdownString();
  content.appendText(`@${definition.kind} · ${definition.symbol}`);
  content.appendMarkdown('\n\n');
  content.appendText(definition.pattern);
  content.appendMarkdown('\n\n');
  content.appendText(stepOrigin(workspace, definition));
  if (definition.documentation) {
    content.appendMarkdown('\n\n');
    content.appendText(definition.documentation);
  }
  return content;
}

/** Escape inserted content for an ordinary Python literal, leaving raw literals unchanged. */
function escapeStepInsertion(text: string, literal?: PythonLiteral): string {
  return literal && !literal.raw
    ? text.replaceAll('\\', '\\\\').replaceAll(literal.quote, '\\' + literal.quote)
    : text;
}

/** Build a snippet that keeps repeated named parameters synchronized. */
function completionSnippet(suggestion: StepSuggestion, separator: string, literal?: PythonLiteral): vscode.SnippetString {
  const snippet = new vscode.SnippetString().appendText(separator);
  const fields = new Map<string, number>();
  let next = 1;
  for (const part of suggestion.parts) {
    if ('text' in part) {
      snippet.appendText(escapeStepInsertion(part.text, literal));
      continue;
    }
    const previous = part.name === null ? undefined : fields.get(part.name);
    if (previous !== undefined) {
      snippet.appendTabstop(previous);
    } else {
      if (part.name !== null) {
        fields.set(part.name, next);
      }
      snippet.appendPlaceholder(escapeStepInsertion(part.name ?? 'value', literal), next++);
    }
  }
  return snippet;
}

/** Register Gherkin providers, commands, and document lifecycle handlers. */
export function activate(context: vscode.ExtensionContext): void {
  registerResourceNavigation(context);
  const diagnostics = vscode.languages.createDiagnosticCollection(language);
  const stepIndex = new StepIndex(context.extensionPath);
  const cache = new WeakMap<vscode.TextDocument, {
    version: number;
    parsed: ReturnType<typeof parseFeature>;
    sections: FeatureSection[];
    allSections: FeatureSection[];
  }>();
  const pending = new Map<vscode.TextDocument, ReturnType<typeof setTimeout>>();
  const validationRuns = new WeakMap<vscode.TextDocument, symbol>();
  const missingSteps = new WeakMap<vscode.TextDocument, Map<number, StepQuery[]>>();

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
    const run = Symbol();
    validationRuns.set(document, run);
    missingSteps.delete(document);
    pending.set(document, setTimeout(() => {
      pending.delete(document);
      const { parsed, allSections } = analyze(document);
      const issues = [...parsed.issues, ...allSections.flatMap((section) => section.tagIssues)];
      const syntax = issues.map((issue) => {
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
      });
      const feature = parsed.document?.feature;
      if (feature) {
        const summary = jiraStorySummary(feature);
        if (summary) {
          const start = new vscode.Position(summary.line, summary.column);
          const end = summary.length ? start.translate(0, summary.length) : document.lineAt(summary.line).range.end;
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(start, end), `Feature @US tag is missing: ${summary.missing.join(', ')}.`,
            vscode.DiagnosticSeverity.Warning
          );
          diagnostic.source = 'Toolium Cucumber';
          diagnostic.code = jiraStorySummaryCode;
          syntax.push(diagnostic);
        }
        const steps = [...actionSteps(feature, document.getText()), ...featureSteps(feature)];
        const outline = steps.filter((step) => step.missingColumns.length).map((step) => {
          const range = document.lineAt(step.line).range.with({ start: new vscode.Position(step.line, step.column) });
          const columns = step.missingColumns.map((name) => `<${name}>`).join(', ');
          const diagnostic = new vscode.Diagnostic(range, `Missing Examples columns: ${columns}.`, vscode.DiagnosticSeverity.Error);
          diagnostic.source = 'Gherkin';
          diagnostic.code = 'missing-examples-columns';
          return diagnostic;
        });
        const base = [...syntax, ...outline];
        diagnostics.set(document.uri, base);
        void validateStepDefinitions(document, steps, base, run, feature.location.line - 1);
      } else {
        diagnostics.set(document.uri, syntax);
      }
    }, diagnosticDelay));
  }

  /** Check all runnable steps with a single worker request, discarding outdated responses. */
  async function validateStepDefinitions(
    document: vscode.TextDocument,
    steps: ReturnType<typeof featureSteps>,
    base: vscode.Diagnostic[],
    run: symbol,
    featureLine: number
  ): Promise<void> {
    const workspace = assistanceWorkspace(document);
    const queries = steps.flatMap((step) => step.checkable ? step.queries.map((query) => ({ step, query })) : []);
    if (!workspace || !queries.length) {
      return;
    }
    const { configuredInterpreter, importPaths } = stepSettings(document, workspace);
    const feature = document.uri.fsPath;
    try {
      const interpreter = await stepInterpreter(configuredInterpreter, dirname(feature), workspace);
      if (validationRuns.get(document) !== run) {
        return;
      }
      const result = await stepIndex.diagnose(interpreter, {
        workspace, feature, importPaths, queries: queries.map(({ query }) => query)
      });
      if (validationRuns.get(document) !== run) {
        return;
      }
      if (result.status === 'incomplete') {
        const first = result.issues[0];
        const origin = vscode.workspace.asRelativePath(vscode.Uri.file(first.path));
        const remaining = result.issueCount > 1 ? ` (${result.issueCount - 1} more)` : '';
        const diagnostic = new vscode.Diagnostic(
          document.lineAt(featureLine).range,
          `Step validation is incomplete. ${first.message} ${origin}:${first.line + 1}${remaining}`,
          vscode.DiagnosticSeverity.Information
        );
        diagnostic.source = 'Toolium Cucumber';
        diagnostic.code = 'incomplete-step-index';
        diagnostic.relatedInformation = result.issues.map((issue) => {
          const position = new vscode.Position(issue.line, 0);
          return new vscode.DiagnosticRelatedInformation(
            new vscode.Location(vscode.Uri.file(issue.path), new vscode.Range(position, position)), issue.message
          );
        });
        diagnostics.set(document.uri, [...base, diagnostic]);
        return;
      }
      if (result.status !== 'complete') {
        return;
      }

      const missing = new Map<number, StepQuery[]>();
      for (const index of result.missing) {
        const { step, query } = queries[index];
        const previous = missing.get(step.line) ?? [];
        if (!previous.length) {
          missing.set(step.line, previous);
        }
        previous.push(query);
      }
      missingSteps.set(document, missing);
      const unresolved = steps.flatMap((step) => {
        const cases = missing.get(step.line);
        if (!cases) {
          return [];
        }
        const range = document.lineAt(step.line).range.with({ start: new vscode.Position(step.line, step.column) });
        const message = cases.length === 1
          ? `No Python step definition found for “${cases[0].text}”.`
          : `No Python step definitions found for ${cases.length} distinct example values.`;
        const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
        diagnostic.source = 'Toolium Cucumber';
        diagnostic.code = undefinedStepCode;
        return [diagnostic];
      });
      diagnostics.set(document.uri, [...base, ...unresolved]);
    } catch {
      // Syntax and outline diagnostics remain available without a working interpreter.
    }
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

  /** Find the trusted file-based workspace used by background step assistance. */
  function assistanceWorkspace(document: vscode.TextDocument): string | undefined {
    const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
    if (vscode.workspace.isTrusted && document.uri.scheme === 'file' && workspace?.uri.scheme === 'file') {
      return workspace.uri.fsPath;
    }
  }

  /** Remove unreferenced Jira keys from the active feature on explicit request. */
  async function cleanJiraStorySummary(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== language) {
      return;
    }
    const { document } = editor;
    const feature = analyze(document).parsed.document?.feature;
    if (!feature) {
      await vscode.window.showInformationMessage('Open a valid feature to clean its @US tag.');
      return;
    }
    const corrections = jiraStoryCleanup(feature);
    if (!corrections.length) {
      vscode.window.setStatusBarMessage('No unreferenced Jira stories in the feature @US tag.', 3000);
      return;
    }
    await editor.edit((edit) => {
      for (const correction of corrections) {
        const start = new vscode.Position(correction.line, correction.column);
        edit.replace(new vscode.Range(start, start.translate(0, correction.length)), correction.text);
      }
    });
  }

  /** Open the Jira issue at the cursor or prompt for its full ID. */
  async function openJiraIssue(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const config = vscode.workspace.getConfiguration('tooliumCucumber.jira', editor?.document.uri);
    const template = config.get<string>('issueUrlTemplate', '');
    if (!jiraIssueUrl(template, 'TOOLIUM-1')) {
      await vscode.window.showInformationMessage('Configure tooliumCucumber.jira.issueUrlTemplate with an HTTP(S) URL containing (id).');
      return;
    }

    let url: string | undefined;
    if (editor) {
      const { document, selection } = editor;
      const range = selection.isEmpty
        ? document.getWordRangeAtPosition(selection.active, /[A-Za-z0-9_]+-[A-Za-z0-9_-]+/)
        : selection;
      if (range) {
        url = jiraIssueUrl(template, document.getText(range));
      }
    }
    if (!url) {
      const value = await vscode.window.showInputBox({
        prompt: 'Enter the full Jira issue ID',
        validateInput: (candidate) => jiraIssueUrl(template, candidate) ? undefined : 'Enter a complete Jira issue ID.'
      });
      if (value === undefined) {
        return;
      }
      url = jiraIssueUrl(template, value);
    }
    if (!url) {
      return;
    }
    try {
      const opened = await openJiraIssueUrl(
        url, config.get('openInIntegratedBrowser', false), openIntegratedBrowser,
        (address) => vscode.env.openExternal(vscode.Uri.parse(address))
      );
      if (opened) {
        return;
      }
    } catch {
      // Report a failed external launch through the same user-facing message.
    }
    await vscode.window.showErrorMessage('Unable to open the Jira issue in the browser.');
  }

  /** Search configured workspace folders for an exact bug ID and open the selected occurrence. */
  async function searchJiraBugReferences(value?: string): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      folder,
      prefixes: jiraBugPrefixes(vscode.workspace.getConfiguration('tooliumCucumber.jira', folder.uri)
        .get<string[]>('bugPrefixes', []))
    })).filter(({ prefixes }) => prefixes.size);
    const prefixes = new Set(folders.flatMap((entry) => [...entry.prefixes]));
    if (!prefixes.size) {
      await vscode.window.showInformationMessage('Configure tooliumCucumber.jira.bugPrefixes in a workspace folder to find Jira bug references.');
      return;
    }
    const input = typeof value === 'string' ? value : await vscode.window.showInputBox({
      prompt: 'Enter the full Jira bug ID',
      validateInput: (candidate) => jiraBugId(candidate, prefixes) ? undefined : 'Enter an ID with a configured Jira project prefix.'
    });
    if (input === undefined) {
      return;
    }
    const id = jiraBugId(input, prefixes);
    if (!id) {
      await vscode.window.showInformationMessage('Enter an ID with a configured Jira project prefix.');
      return;
    }

    const results = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Finding Jira bug references for ${id}`,
      cancellable: true
    }, async (_progress, token) => {
      const matches: (vscode.QuickPickItem & { uri: vscode.Uri; range: vscode.Range; sourceText: string })[] = [];
      const open = new Map(vscode.workspace.textDocuments.map((document) => [document.uri.toString(), document]));
      for (const { folder, prefixes: allowed } of folders) {
        if (!jiraBugId(id, allowed)) {
          continue;
        }
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.feature'),
          '**/{.git,.venv,venv,node_modules}/**', undefined, token);
        for (const uri of files.sort((a, b) => a.path.localeCompare(b.path))) {
          if (token.isCancellationRequested) {
            return;
          }
          if (vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== folder.uri.toString()) {
            continue;
          }
          try {
            // Reading unopened files directly avoids triggering editor diagnostics across the workspace.
            const document = open.get(uri.toString());
            const source = document?.getText() ?? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
            if (!source.includes('@jira.link.detects.')) {
              continue;
            }
            const feature = (document ? analyze(document).parsed : parseFeature(source)).document?.feature;
            if (!feature) {
              continue;
            }
            const lines = source.split(/\r\n|\r|\n/);
            for (const match of findJiraBugReferences(feature, id, allowed)) {
              const start = new vscode.Position(match.line, match.column);
              matches.push({
                label: match.label,
                description: `${vscode.workspace.asRelativePath(uri, true)}:${match.line + 1}`,
                detail: match.kind === 'tag' ? 'Jira acceptance link tag' : 'Examples cell',
                uri, range: new vscode.Range(start, start.translate(0, match.length)),
                sourceText: lines[match.line].slice(match.column, match.column + match.length)
              });
            }
          } catch {
            // One missing or unreadable feature should not hide other references.
          }
        }
      }
      return token.isCancellationRequested ? undefined : matches;
    });
    if (!results) {
      return;
    }
    if (!results.length) {
      await vscode.window.showInformationMessage(`No Jira bug references found for ${id}.`);
      return;
    }
    const selected = results.length === 1 ? results[0] : await vscode.window.showQuickPick(results, {
      placeHolder: `Select a reference to ${id}`, matchOnDescription: true
    });
    if (selected) {
      const document = await vscode.workspace.openTextDocument(selected.uri);
      if (document.getText(selected.range) === selected.sourceText) {
        await vscode.window.showTextDocument(document, { selection: selected.range });
      } else {
        await vscode.window.showInformationMessage('The feature changed. Run the Jira bug reference search again.');
      }
    }
  }

  /** Offer a feature tag correction or a scaffold for an undefined step. */
  function provideQuickFixes(
    document: vscode.TextDocument, _range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    return context.diagnostics.flatMap((diagnostic) => {
      if (diagnostic.code === jiraStorySummaryCode) {
        const feature = analyze(document).parsed.document?.feature;
        const summary = feature && jiraStorySummary(feature);
        if (!summary) {
          return [];
        }
        const action = new vscode.CodeAction('Update feature @US tag', vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        const edit = new vscode.WorkspaceEdit();
        if (summary.length) {
          const start = new vscode.Position(summary.line, summary.column);
          edit.replace(document.uri, new vscode.Range(start, start.translate(0, summary.length)), summary.text);
        } else {
          const newline = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
          const indentation = document.lineAt(summary.line).text.slice(0, summary.column);
          edit.insert(document.uri, new vscode.Position(summary.line, 0), indentation + summary.text + newline);
        }
        action.edit = edit;
        return [action];
      }
      const line = diagnostic.range.start.line;
      if (diagnostic.code !== undefinedStepCode || !missingSteps.get(document)?.has(line)) {
        return [];
      }
      const title = 'Create Python step definition';
      const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diagnostic];
      action.command = { title, command: createStepCommand, arguments: [document.uri, document.version, line] };
      return [action];
    });
  }

  /** Find a destination name without overwriting an existing step module. */
  async function scaffoldTarget(directory: string, stem: string): Promise<vscode.Uri> {
    for (let suffix = 1; ; suffix++) {
      const name = suffix === 1 ? stem : `${stem}_${suffix}`;
      const target = vscode.Uri.file(join(directory, name + '.py'));
      try {
        await vscode.workspace.fs.stat(target);
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
          return target;
        }
        throw error;
      }
    }
  }

  /** Recheck a reported step and create its Python scaffold in the suite's steps directory. */
  async function createStepDefinition(uri: vscode.Uri, version: number, line: number): Promise<void> {
    const document = vscode.workspace.textDocuments.find((entry) => entry.uri.toString() === uri.toString());
    if (!document || document.version !== version) {
      return;
    }
    const workspace = assistanceWorkspace(document);
    const queries = missingSteps.get(document)?.get(line);
    if (!workspace || !queries?.length) {
      return;
    }
    const selection = queries.length === 1 ? { query: queries[0] } : await vscode.window.showQuickPick(
      queries.map((query) => ({ label: query.text, query })),
      { placeHolder: 'Select an unresolved Examples value' }
    );
    if (!selection || document.isClosed || document.version !== version) {
      return;
    }

    const { query } = selection;
    const { configuredInterpreter, importPaths } = stepSettings(document, workspace);
    try {
      const feature = uri.fsPath;
      const interpreter = await stepInterpreter(configuredInterpreter, dirname(feature), workspace);
      const result = await stepIndex.diagnose(interpreter, { workspace, feature, importPaths, queries: [query] });
      if (document.isClosed || document.version !== version) {
        return;
      }
      if (result.status !== 'complete' || !result.missing.length) {
        validate(document);
        await vscode.window.showInformationMessage('This step can no longer be confirmed as undefined.');
        return;
      }

      const { fileStem, source } = stepScaffold(query.text);
      const target = await scaffoldTarget(result.stepsDirectory, fileStem);
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(target, { overwrite: false, ignoreIfExists: false, contents: new TextEncoder().encode(source) });
      if (!await vscode.workspace.applyEdit(edit)) {
        await vscode.window.showErrorMessage('Unable to create the Python step definition.');
        return;
      }
      const start = new vscode.Position(5, 4);
      await vscode.window.showTextDocument(target, { selection: new vscode.Range(start, start) });
      validate(document);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(`Unable to create the Python step definition. ${message}`);
    }
  }

  /** Refresh open feature diagnostics when Python files, trust, or index settings change. */
  function validateOpenFeatures(): void {
    vscode.workspace.textDocuments.forEach(validate);
  }

  /** Discover workspace suites that import a shared Python caller. */
  async function sharedStepSuites(interpreter: string, workspace: string, path: string, importPaths: string[]) {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspace, '**/steps/*.py'), '**/{.git,.venv,venv,node_modules}/**'
    );
    const suites = [...new Set(files.map((file) => dirname(dirname(file.fsPath))))].sort();
    return stepIndex.findSuites(interpreter, { workspace, path, suites, importPaths });
  }

  /** Offer suite-specific step bodies while the user types after a Gherkin keyword. */
  async function provideStepCompletions(
    document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken
  ): Promise<vscode.CompletionList | undefined> {
    const workspace = assistanceWorkspace(document);
    if (!workspace || token.isCancellationRequested) {
      return;
    }
    const version = document.version;
    const source = document.getText();
    const currentLine = document.lineAt(position.line);
    const python = document.languageId === 'python';
    if (python && (!/^\s*(?:Given|When|Then|And|But)(?:\s|$)/.test(currentLine.text)
      || !source.includes('execute_steps'))) {
      return;
    }
    let context = python ? undefined : stepCompletionContext(source, position.line, position.character);
    if (!python && !context) {
      return;
    }
    const { configuredInterpreter, importPaths } = stepSettings(document, workspace);
    try {
      const path = document.uri.fsPath;
      const interpreter = await stepInterpreter(configuredInterpreter, dirname(path), workspace);
      if (token.isCancellationRequested) {
        return;
      }
      let literal: PythonLiteral | undefined;
      let suites: string[] = [];
      if (python) {
        const snippet = await stepIndex.inspectPython(interpreter, {
          workspace, path, source, line: position.line,
          column: Array.from(currentLine.text.slice(0, position.character)).length
        });
        if (!snippet?.completion || token.isCancellationRequested) {
          return;
        }
        literal = snippet.completion;
        context = stepCompletionContext(
          `Feature: Steps\nScenario: Inline steps\n${snippet.text}`, snippet.line + 2, position.character
        );
        if (!context || context.kind === 'step') {
          return;
        }
        suites = snippet.suite ? [snippet.suite] : await sharedStepSuites(interpreter, workspace, path, importPaths);
      }
      if (!context || token.isCancellationRequested || document.version !== version) {
        return;
      }
      const { kind, prefix, start: startColumn, separator } = context;
      const request = { workspace, importPaths, kind, prefix };
      const results = python
        ? await Promise.allSettled(suites.map(async (suite) => {
          const selectedInterpreter = await stepInterpreter(configuredInterpreter, suite, workspace);
          return stepIndex.complete(selectedInterpreter, { ...request, suite });
        }))
        : [{ status: 'fulfilled' as const, value: await stepIndex.complete(interpreter, { ...request, feature: path }) }];
      if (token.isCancellationRequested || document.version !== version) {
        return;
      }

      const items = new Map<string, StepSuggestion>();
      let incomplete = false;
      for (const result of results) {
        if (result.status === 'fulfilled') {
          incomplete ||= result.value.incomplete;
          for (const suggestion of result.value.items) {
            const key = JSON.stringify(suggestion.parts);
            if (!items.has(key)) {
              items.set(key, suggestion);
            }
          }
        }
      }
      const start = new vscode.Position(position.line, startColumn);
      const end = currentLine.range.end;
      const completions: vscode.CompletionItem[] = [];
      for (const suggestion of items.values()) {
        const label = suggestion.parts.map((part) => 'text' in part ? part.text : `{${part.name ?? 'value'}}`).join('');
        // A delimiter character in a raw string cannot be escaped without changing the step text.
        if (literal && (/[\r\n\0]/.test(label) || (literal.raw && label.includes(literal.quote)))) {
          continue;
        }
        if (completions.length === 100) {
          incomplete = true;
          break;
        }
        const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Function);
        item.range = { inserting: new vscode.Range(start, position), replacing: new vscode.Range(start, end) };
        item.sortText = String(completions.length).padStart(3, '0');
        if (!label.toLowerCase().startsWith(prefix.toLowerCase())) {
          item.filterText = prefix + ' ' + label;
        }
        item.insertText = completionSnippet(suggestion, separator, literal);
        item.detail = stepOrigin(workspace, suggestion);
        item.documentation = stepDocumentation(workspace, suggestion);
        completions.push(item);
      }
      return new vscode.CompletionList(completions, incomplete);
    } catch {
      // Explicit navigation reports configuration errors without interrupting typing.
      return;
    }
  }

  /** Show the resolved Python function, pattern, source, and docstring over a step. */
  async function provideStepHover(
    document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    const workspace = assistanceWorkspace(document);
    if (!workspace || token.isCancellationRequested) {
      return;
    }
    const feature = analyze(document).parsed.document?.feature;
    if (!feature) {
      return;
    }
    const version = document.version;
    const queries = stepQueries(feature, position.line);
    if (!queries.length) {
      queries.push(...actionStepQuery(feature, document.getText(), position.line));
    }
    if (!queries.length) {
      return;
    }
    const { configuredInterpreter, importPaths } = stepSettings(document, workspace);
    try {
      const path = document.uri.fsPath;
      const interpreter = await stepInterpreter(configuredInterpreter, dirname(path), workspace);
      if (token.isCancellationRequested) {
        return;
      }
      const { matches } = await stepIndex.resolve(interpreter, { workspace, feature: path, importPaths, queries });
      if (token.isCancellationRequested || document.version !== version || !matches.length) {
        return;
      }
      return new vscode.Hover(
        matches.map((definition) => stepDocumentation(workspace, definition)),
        document.lineAt(position.line).range
      );
    } catch {
      return;
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
    const { configuredInterpreter, importPaths } = stepSettings(document, workspacePath);
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
          const suites = await sharedStepSuites(interpreter, workspacePath, sourcePath, importPaths);
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
          return { label: match.symbol, description: stepOrigin(workspacePath, match), detail: match.pattern, match };
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

  const pythonFiles = vscode.workspace.createFileSystemWatcher('**/{steps,*.py}');
  context.subscriptions.push(
    diagnostics,
    stepIndex,
    pythonFiles,
    pythonFiles.onDidCreate(validateOpenFeatures),
    pythonFiles.onDidChange(validateOpenFeatures),
    pythonFiles.onDidDelete(validateOpenFeatures),
    vscode.workspace.onDidGrantWorkspaceTrust(validateOpenFeatures),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('tooliumCucumber')) {
        validateOpenFeatures();
      }
    }),
    new vscode.Disposable(() => pending.forEach((timer) => clearTimeout(timer))),
    vscode.workspace.onDidOpenTextDocument(validate),
    vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
      if (contentChanges.length) {
        validate(document);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      cancelValidation(document);
      validationRuns.delete(document);
      missingSteps.delete(document);
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
    vscode.languages.registerDocumentFormattingEditProvider(language, {
      /** Use the editor's configured indentation and return only changed source lines. */
      provideDocumentFormattingEdits(document, options, token) {
        if (token.isCancellationRequested) {
          return [];
        }
        const indent = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
        return formatFeature(document.getText(), indent).map(({ line, text }) => {
          const original = document.lineAt(line).text;
          let start = 0;
          let end = original.length;
          let newEnd = text.length;
          while (start < end && start < newEnd && original[start] === text[start]) {
            start++;
          }
          while (end > start && newEnd > start && original[end - 1] === text[newEnd - 1]) {
            end--;
            newEnd--;
          }
          return vscode.TextEdit.replace(new vscode.Range(line, start, line, end), text.slice(start, newEnd));
        });
      }
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
    vscode.languages.registerCompletionItemProvider([{ language, scheme: 'file' }, { language: 'python', scheme: 'file' }], {
      provideCompletionItems: provideStepCompletions
    }, ' '),
    vscode.languages.registerHoverProvider({ language, scheme: 'file' }, { provideHover: provideStepHover }),
    vscode.languages.registerCodeActionsProvider({ language, scheme: 'file' }, {
      provideCodeActions: provideQuickFixes
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.commands.registerCommand(createStepCommand, createStepDefinition),
    vscode.commands.registerCommand('toolium-cucumber.cleanJiraStorySummary', cleanJiraStorySummary),
    vscode.commands.registerCommand('toolium-cucumber.findJiraBugReferences', searchJiraBugReferences),
    vscode.commands.registerCommand('toolium-cucumber.openJiraIssue', openJiraIssue),
    vscode.commands.registerCommand('toolium-cucumber.findByTag', findByTag),
    vscode.commands.registerCommand('toolium-cucumber.goToStepDefinition', goToStepDefinition)
  );
  validateOpenFeatures();
}
