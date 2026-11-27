import * as vscode from 'vscode';
import { isMap, isScalar, parseDocument } from 'yaml';
import { placeholderMatches } from './resolver';
import { configuredBases, resourceConfiguration, withinResourceBase } from './paths';
import { resourceUsageMatcher, type UsageMatcher } from './usageTargets';

/** Returns a literal mapping path only when the cursor is on its key. */
export function yamlKeyAt(text: string, offset: number): string[] | undefined {
  const doc = parseDocument(text);
  if (doc.errors.length) return;
  /** Find the scalar mapping key at the source offset and retain its parent path. */
  function walk(node: unknown, path: string[]): string[] | undefined {
    if (!isMap(node)) return;
    for (const pair of node.items) {
      if (!isScalar(pair.key) || !pair.key.range) continue;
      const key = String(pair.key.value);
      if (!key || /[.<>\[\]:\r\n]/.test(key)) continue;
      const next = [...path, key];
      if (offset >= pair.key.range[0] && offset < pair.key.range[1]) return next;
      const child = walk(pair.value, next);
      if (child) return child;
    }
  }
  return walk(doc.contents, []);
}

/** Matches a LANG key and its descendants by literal path segments. */
function languageUsageMatcher(path: string[]): UsageMatcher {
  return ref => ref.kind === 'LANG' && path.every((key, i) => key === ref.path[i]);
}

/** Find literal references to the specified LANG key and its descendants. */
export function usageOffsets(text: string, path: string[]): { start: number; end: number }[] {
  return path.length ? matchingUsageOffsets(text, languageUsageMatcher(path)) : [];
}

/** Collect source ranges for the references accepted by a usage matcher. */
export function matchingUsageOffsets(text: string, matcher: UsageMatcher): { start: number; end: number }[] {
  const results: { start: number; end: number }[] = [];
  for (const ref of placeholderMatches(text, true)) {
    if (matcher(ref)) results.push({ start: ref.start, end: ref.end });
  }
  return results;
}

/** Find resource usages in the configured reference directories of the current workspace. */
export async function findUsages(document: vscode.TextDocument, position: vscode.Position,
  token: vscode.CancellationToken): Promise<vscode.Location[]> {
  if (token.isCancellationRequested) return [];
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) return [];
  const config = vscode.workspace.getConfiguration(resourceConfiguration, document.uri);
  let matcher: UsageMatcher | undefined;
  if (/\.ya?ml$/i.test(document.uri.path)) {
    const resourceBases = configuredBases(folder.uri,
      config.get<string[]>('resourcePaths', ['acceptance/resources/language']));
    if (!resourceBases.some(base => withinResourceBase(document.uri, base))) return [];
    const path = yamlKeyAt(document.getText(), document.offsetAt(position));
    if (!path) return [];
    matcher = languageUsageMatcher(path);
  } else {
    matcher = resourceUsageMatcher(document, document.offsetAt(position), folder.uri, config);
  }
  if (!matcher) return [];
  const bases = configuredBases(folder.uri,
    config.get<string[]>('referencePaths', ['acceptance/common', 'acceptance/features']));
  const candidates = new Map<string, vscode.Uri>();
  for (const base of bases) {
    if (token.isCancellationRequested) return [];
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(base, '**/*.{py,feature}'),
      '**/{.git,node_modules,.venv,venv,__pycache__}/**', undefined, token);
    for (const uri of files) {
      if (withinResourceBase(uri, base)) candidates.set(uri.toString(), uri);
    }
  }
  const results: vscode.Location[] = [];
  for (const uri of [...candidates.values()].sort((a, b) => a.toString().localeCompare(b.toString()))) {
    if (token.isCancellationRequested) return [];
    try {
      const source = await vscode.workspace.openTextDocument(uri);
      for (const match of matchingUsageOffsets(source.getText(), matcher)) {
        results.push(new vscode.Location(uri,
          new vscode.Range(source.positionAt(match.start), source.positionAt(match.end))));
      }
    } catch {
      // A removed or unreadable file must not hide other usages.
    }
  }
  return token.isCancellationRequested ? [] : results;
}

/** Register Find All References on supported resource files. */
export function registerUsageProviders(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = [{ language: 'yaml' }, { pattern: '**/*.{yaml,yml,json}' },
    { pattern: '**/toolium.cfg' }, { pattern: '**/local-toolium.cfg' }];
  context.subscriptions.push(
    vscode.languages.registerReferenceProvider(selector, {
      /** Return usages of the resource key under the cursor. */
      provideReferences(document, position, _context, token) {
        return findUsages(document, position, token);
      }
    })
  );
}
