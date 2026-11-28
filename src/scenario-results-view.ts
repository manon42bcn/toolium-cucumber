import { isAbsolute, resolve } from 'node:path';
import * as vscode from 'vscode';
import { readScenarioResults, RunState, scenarioResultsHtml } from './scenario-results';

const formatter = 'toolium_cucumber_results:ResultsFormatter';
const openResultsCommand = 'toolium-cucumber.showScenarioResults';
const pollInterval = 250;

interface LiveLaunch {
  uri: vscode.Uri;
  previous: string | undefined;
  revision?: string;
  report?: ReturnType<typeof readScenarioResults>;
  timer?: ReturnType<typeof setTimeout>;
  polling?: Promise<void>;
  stopped: boolean;
  exited: boolean;
  cancelled: boolean;
}

/** Find the file paired with our formatter in an already resolved Behave launch. */
function launchResultsFile(session: vscode.DebugSession): vscode.Uri | undefined {
  const { module, args, cwd } = session.configuration;
  if (module !== 'behave' || !Array.isArray(args)) {
    return;
  }
  const formats: string[] = [];
  const outputs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') {
      break;
    }
    const match = typeof argument === 'string' ? /^(--format|--outfile|-f|-o)(?:=(.*))?$/.exec(argument) : null;
    if (match) {
      const value = match[2] ?? args[++index];
      (match[1] === '-f' || match[1] === '--format' ? formats : outputs).push(value);
    }
  }
  const output = outputs[formats.indexOf(formatter)];
  if (typeof output !== 'string' || !output || output === '-' || output.includes('${')) {
    return;
  }
  const directory = cwd ?? session.workspaceFolder?.uri.fsPath;
  if (isAbsolute(output)) {
    return vscode.Uri.file(output);
  }
  return typeof directory === 'string' && isAbsolute(directory) ? vscode.Uri.file(resolve(directory, output)) : undefined;
}

/** Describe the current file revision so an aborted launch cannot reopen the previous report. */
async function fileRevision(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const { mtime, size } = await vscode.workspace.fs.stat(uri);
    return `${mtime}:${size}`;
  } catch {
    return;
  }
}

/** Add the results command and follow reports from configured F5 launches. */
export function registerScenarioResultsView(context: vscode.ExtensionContext): void {
  let panel: vscode.WebviewPanel | undefined;
  let displayedLaunch: LiveLaunch | undefined;
  const launches = new Map<string, LiveLaunch>();

  /** Render results beside the editor and keep focus where the user is working. */
  function showReport(report: LiveLaunch['report'], state: RunState): void {
    const html = scenarioResultsHtml(report?.scenarios ?? [], state);
    if (!panel) {
      panel = vscode.window.createWebviewPanel('tooliumCucumber.scenarioResults', 'Scenario Results',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { localResourceRoots: [] });
      panel.onDidDispose(() => {
        panel = undefined;
        displayedLaunch = undefined;
      });
    }
    panel.webview.html = html;
  }

  /** Load the latest committed records when the results file changes. */
  async function refresh(launch: LiveLaunch): Promise<boolean> {
    const revision = await fileRevision(launch.uri);
    if (!revision || revision === launch.previous || revision === launch.revision) {
      return false;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(launch.uri);
      launch.report = readScenarioResults(new TextDecoder().decode(bytes), true);
      launch.revision = revision;
      return true;
    } catch {
      // Behave can truncate or start writing the file between stat and read. Retry on the next poll.
      return false;
    }
  }

  /** Schedule the next read only after the current read has finished. */
  function poll(launch: LiveLaunch): void {
    launch.timer = setTimeout(() => {
      launch.polling = refresh(launch).then((changed) => {
        if (launch.stopped) {
          return;
        }
        if (changed && displayedLaunch === launch) {
          showReport(launch.report, 'running');
        }
        poll(launch);
      });
    }, pollInterval);
  }

  /** Stop polling while allowing an already active read to settle. */
  function stop(launch: LiveLaunch): void {
    launch.stopped = true;
    clearTimeout(launch.timer);
  }

  /** Open a saved report selected by the user or supplied by a command caller. */
  async function openSavedReport(uri?: vscode.Uri): Promise<void> {
    const file = uri ?? (await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      filters: { 'Behave Results': ['jsonl'] },
      openLabel: 'Open Scenario Results'
    }))?.[0];
    if (file) {
      try {
        const bytes = await vscode.workspace.fs.readFile(file);
        const report = readScenarioResults(new TextDecoder().decode(bytes));
        displayedLaunch = undefined;
        showReport(report, 'finished');
        panel?.reveal(undefined, true);
      } catch (error) {
        void vscode.window.showErrorMessage(`Unable to open Scenario Results. ${error instanceof Error ? error.message : ''}`);
      }
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(openResultsCommand, openSavedReport),
    vscode.debug.registerDebugAdapterTrackerFactory('debugpy', {
      /** Capture the output file before the debug adapter launches Behave. */
      createDebugAdapterTracker(session) {
        const uri = launchResultsFile(session);
        if (!uri) {
          return;
        }
        const launch: LiveLaunch = { uri, previous: undefined, stopped: false, exited: false, cancelled: false };
        launches.set(session.id, launch);
        return {
          /** Start the live view before the adapter launches the Python process. */
          onWillStartSession() {
            displayedLaunch = launch;
            showReport(undefined, 'running');
            panel?.reveal(undefined, true);
            launch.polling = fileRevision(uri).then((revision) => {
              launch.previous = revision;
              if (!launch.stopped) {
                poll(launch);
              }
            });
          },
          /** Identify a stop request sent before the debuggee reports its own exit. */
          onWillReceiveMessage(message) {
            if (message.type === 'request' && !launch.exited &&
              (message.command === 'terminate' || message.command === 'disconnect')) {
              launch.cancelled = true;
            }
          },
          /** Track normal debuggee exit before the adapter disconnects. */
          onDidSendMessage(message) {
            if (message.type === 'event' && (message.event === 'exited' || message.event === 'terminated')) {
              launch.exited = true;
            }
          }
        };
      }
    }),
    vscode.debug.onDidTerminateDebugSession(async (session) => {
      const launch = launches.get(session.id);
      launches.delete(session.id);
      if (!launch) {
        return;
      }
      stop(launch);
      await launch.polling;
      await refresh(launch);
      if (displayedLaunch === launch) {
        const state = launch.cancelled ? 'cancelled' : launch.report?.complete ? 'finished' : 'interrupted';
        showReport(launch.report, state);
      }
    }),
    new vscode.Disposable(() => {
      for (const launch of launches.values()) {
        stop(launch);
      }
      launches.clear();
      panel?.dispose();
    })
  );
}
