interface SourceLocation {
  file: string;
  line: number;
}

interface Result {
  status: string;
  duration?: number;
  error?: string;
}

interface Step {
  name: string;
  running?: boolean;
  result?: Result;
}

interface Scenario {
  name: string;
  feature?: string;
  example?: { name: string; location: SourceLocation; rowLine: number };
  result?: Result;
  steps: Map<number, Step>;
}

export type RunState = 'running' | 'finished' | 'cancelled' | 'interrupted';

/** Read a version-one report, ignoring a partial last record while Behave is writing. */
export function readScenarioResults(source: string, allowPartial = false): { complete: boolean; scenarios: Scenario[] } {
  const completeLines = allowPartial ? source.slice(0, source.lastIndexOf('\n') + 1) : source;
  const lines = completeLines.trim().split(/\r?\n/);
  const events = lines.map((line) => JSON.parse(line));
  const complete = events.at(-1)?.event === 'runFinished';
  if (events[0]?.event !== 'runStarted' || events[0].version !== 1
    || (!allowPartial && !complete)) {
    throw new Error('The Behave results file is incomplete or uses an unsupported format.');
  }

  const scenarios = new Map<number, Scenario>();
  let feature: string | undefined;
  for (const event of events) {
    if (!event || typeof event !== 'object') {
      throw new Error('The Behave results file contains an invalid event.');
    }
    const scenario = scenarios.get(event.scenarioId);
    switch (event.event) {
      case 'feature':
        feature = event.name;
        break;
      case 'scenarioStarted':
        scenarios.set(event.scenarioId, { name: event.name, example: event.example, feature, steps: new Map() });
        break;
      case 'step':
        scenario?.steps.set(event.stepId, { name: `${event.keyword} ${event.name}` });
        break;
      case 'stepStarted': {
        const step = scenario?.steps.get(event.stepId);
        if (step) {
          step.running = true;
        }
        break;
      }
      case 'stepFinished': {
        const step = scenario?.steps.get(event.stepId);
        if (step) {
          step.running = false;
          step.result = event;
        }
        break;
      }
      case 'scenarioFinished':
        if (scenario) {
          scenario.result = event;
        }
        break;
    }
  }
  return { complete, scenarios: [...scenarios.values()] };
}

/** Escape report text before placing it in the script-free webview. */
function escapeHtml(value: unknown): string {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** Map Behave statuses to display categories while preserving the original status label. */
function category(result?: Result): 'passed' | 'failed' | 'skipped' | 'pending' {
  switch (result?.status) {
    case 'passed':
      return 'passed';
    case 'skipped':
      return 'skipped';
    case 'undefined':
    case 'pending':
    case 'failed':
    case 'error':
    case 'hook_error':
    case 'cleanup_error':
      return 'failed';
    default:
      return 'pending';
  }
}

/** Format an accessible status marker and elapsed time. */
function status(result?: Result): string {
  const kind = category(result);
  const active = result?.status === 'running';
  const icon = active ? '▶' : { passed: '✓', failed: '✕', skipped: '–', pending: '○' }[kind];
  const label = typeof result?.status === 'string' ? result.status.replaceAll('_', ' ') : 'No result';
  const seconds = result?.duration;
  const duration = typeof seconds === 'number' && Number.isFinite(seconds)
    ? `<span class="time">${seconds.toFixed(2)} s</span>` : '';
  return `<span class="status ${active ? 'running' : kind}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon}</span>${duration}`;
}

/** Render an available error as plain text. */
function errorDetail(result?: Result): string {
  return result?.error ? `<pre>${escapeHtml(result.error)}</pre>` : '';
}

/** Render a scenario or Examples row with its emitted steps in source order. */
function scenarioDetails(scenario: Scenario, state: RunState): string {
  const steps = [...scenario.steps.values()].map((step) =>
    `<li><div class="entry">${status(step.result ?? (step.running && state === 'running' ? { status: 'running' } : undefined))}<span>${escapeHtml(step.name)}</span></div>${errorDetail(step.result)}</li>`
  ).join('');
  const row = scenario.example ? `<span class="meta">Examples line ${escapeHtml(scenario.example.rowLine)}</span>` : '';
  const expanded = !scenario.example || category(scenario.result) === 'failed' || (state === 'running' && !scenario.result);
  return `<details class="scenario"${expanded ? ' open' : ''}>
    <summary><span class="entry">${status(scenario.result)}<span>${escapeHtml(scenario.name)}</span>${row}</span></summary>
    ${errorDetail(scenario.result)}${steps ? `<ol>${steps}</ol>` : ''}
  </details>`;
}

/** Build the final results view, grouping expanded rows by outline source location. */
export function scenarioResultsHtml(scenarios: readonly Scenario[], state: RunState = 'finished'): string {
  const groups = new Map<string | Scenario, Scenario[]>();
  for (const scenario of scenarios) {
    const key = scenario.example
      ? JSON.stringify([scenario.example.location.file, scenario.example.location.line])
      : scenario;
    const group = groups.get(key);
    if (group) {
      group.push(scenario);
    } else {
      groups.set(key, [scenario]);
    }
  }
  const counts = { passed: 0, failed: 0, skipped: 0, pending: 0 };
  for (const scenario of scenarios) {
    counts[category(scenario.result)]++;
  }
  const stats = Object.entries(counts).filter(([, count]) => count)
    .map(([kind, count]) => `<span class="${kind}">${count} ${kind}</span>`).join(' · ');
  const content = [...groups.values()].map((group) => {
    const { example, feature } = group[0];
    return `<section>${feature ? `<p class="meta">${escapeHtml(feature)}</p>` : ''}
      ${example ? `<h2>${escapeHtml(example.name)}</h2>` : ''}${group.map((scenario) => scenarioDetails(scenario, state)).join('')}</section>`;
  }).join('');
  const runLabel = { running: 'Running', finished: 'Finished', cancelled: 'Cancelled', interrupted: 'Interrupted' }[state];

  return `<!doctype html>
  <html lang="en"><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Scenario Results</title>
  <style>
    body { margin: 0; padding: 1.5rem; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); }
    header { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: .5rem 1rem; }
    h1 { font-size: 1.4em; margin: 0; } h2 { font-size: 1.15em; margin: .25rem 0 .65rem; }
    section { margin-top: 1.25rem; } .meta, .time { color: var(--vscode-descriptionForeground); }
    .meta { margin: 0; } .time { font-variant-numeric: tabular-nums; order: 1; margin-left: auto; white-space: nowrap; }
    .scenario { margin: .5rem 0; border: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border)); border-radius: 4px; }
    summary { padding: .65rem .75rem; cursor: pointer; overflow-wrap: anywhere; }
    summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    summary .entry { display: inline-flex; margin-left: .35rem; width: calc(100% - 1.6rem); }
    .entry { display: flex; align-items: baseline; gap: .55rem; overflow-wrap: anywhere; }
    .status { display: inline-block; flex: 0 0 1em; font-weight: bold; }
    .passed { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
    .failed { color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground)); }
    .running { color: var(--vscode-progressBar-background); }
    .skipped, .pending { color: var(--vscode-descriptionForeground); }
    ol { margin: 0; padding: 0 .75rem .65rem 1.55rem; list-style: none; }
    li { margin: .45rem 0; font-family: var(--vscode-editor-font-family); }
    pre { margin: .45rem .75rem; padding: .65rem; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--vscode-errorForeground); background: var(--vscode-textCodeBlock-background); }
  </style></head><body>
  <header><h1>Scenario Results</h1><div>${stats}</div></header>
  <p class="meta">${runLabel}</p>
  ${content || (state === 'running' ? '<p>Waiting for scenario results…</p>' : '<p>No scenario results were recorded.</p>')}
  </body></html>`;
}
