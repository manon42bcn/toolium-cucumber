import * as vscode from 'vscode';
import { win32 } from 'node:path';

export const resourceConfiguration = 'tooliumCucumber.resources';

/** Resolves workspace-relative folders. An empty string selects the root; [] disables searching. */
export function configuredBases(folder: vscode.Uri, paths: string[]): vscode.Uri[] {
  return paths.filter(path => !path.startsWith('/') && !path.includes('\\')
    && !path.includes(':') && !path.split('/').includes('..'))
    .map(path => path === '' ? folder : vscode.Uri.joinPath(folder, path));
}

/** Check that a resource or usage URI is a descendant of its configured directory. */
export function withinResourceBase(uri: vscode.Uri, base: vscode.Uri): boolean {
  return !!resourceRelativePath(uri, base);
}

/** Return a slash-separated relative path only when both URIs share the same resource base. */
export function resourceRelativePath(
  uri: vscode.Uri, base: vscode.Uri, platform = process.platform
): string | undefined {
  if (uri.scheme !== base.scheme) {
    return;
  }
  if (platform === 'win32' && uri.scheme === 'file') {
    const path = win32.relative(base.fsPath, uri.fsPath);
    if (!win32.isAbsolute(path) && path !== '..' && !path.startsWith('..\\')) {
      return path.replaceAll('\\', '/');
    }
    return;
  }
  if (uri.authority !== base.authority) {
    return;
  }
  if (uri.path === base.path) {
    return '';
  }
  const prefix = base.path.replace(/\/$/, '') + '/';
  return uri.path.startsWith(prefix) ? uri.path.slice(prefix.length) : undefined;
}
