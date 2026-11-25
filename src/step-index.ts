import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { StepQuery } from './feature';

export interface StepDefinition {
  path: string;
  line: number;
  symbol: string;
  kind: StepQuery['kind'];
  pattern: string;
  documentation: string | null;
}

export interface StepSuggestion extends StepDefinition {
  parts: ({ text: string } | { name: string | null; type: string })[];
}

export interface StepIndexResult {
  suiteFound: boolean;
  matches: StepDefinition[];
}

export type StepDiagnosticResult = {
  status: 'complete';
  stepsDirectory: string;
  missing: number[];
} | { status: 'incomplete' | 'unavailable' };

type SuiteLocation = { feature: string } | { suite: string };

type IndexRequest = {
  workspace: string;
  importPaths: string[];
  queries: StepQuery[];
} & SuiteLocation;

interface PythonStepRequest {
  workspace: string;
  path: string;
  source: string;
  line: number;
  column: number;
}

interface SuiteRequest {
  workspace: string;
  path: string;
  importPaths: string[];
  suites: string[];
}

interface StepSnippet {
  text: string;
  line: number;
  suite: string | null;
  completion: PythonLiteral | null;
}

export interface PythonLiteral {
  quote: '"' | "'";
  raw: boolean;
}

interface PendingRequest {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

type WorkerResponse = { result: unknown } | { error: string };

/** Generate a literal Behave step with a valid Python identifier and escaped parse braces. */
export function stepScaffold(text: string): { fileStem: string; source: string } {
  const name = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  const fileStem = 'step_' + (name || 'definition');
  const pattern = JSON.stringify(text.replace(/[{}]/g, '$&$&'));
  return {
    fileStem,
    source: [
      'from behave import step',
      '',
      '',
      `@step(${pattern})`,
      `def ${fileStem}(context):`,
      '    """Implement the step described by the decorator."""',
      '    raise NotImplementedError("Implement this step")',
      ''
    ].join('\n')
  };
}

class IndexWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending: PendingRequest[] = [];
  private closed = false;

  /** Start an isolated Python process that keeps its source cache between lookups. */
  constructor(interpreter: string, script: string) {
    this.child = spawn(interpreter, ['-I', '-S', '-u', script], {
      stdio: 'pipe',
      windowsHide: true
    });
    const output = createInterface({ input: this.child.stdout });
    output.on('line', (line) => this.receive(line));
    this.child.stderr.resume();
    this.child.stdin.on('error', (error) => this.stop(error));
    this.child.on('error', (error) => this.stop(error));
    this.child.on('exit', (code) => this.stop(new Error(`Python step index exited (${code ?? 'signal'}).`)));
  }

  /** Report whether this process can still accept requests. */
  get available(): boolean {
    return !this.closed;
  }

  /** Send a lookup and reject outstanding requests if the process becomes unresponsive. */
  request<T>(request: object): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.stop(new Error('Python step index timed out.')), 15_000);
      this.pending.push({ resolve: (result) => resolve(result as T), reject, timeout });
      this.child.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  /** Finish the oldest request because the worker emits responses in input order. */
  private receive(line: string): void {
    const request = this.pending.shift();
    if (!request) {
      return;
    }
    clearTimeout(request.timeout);
    try {
      const response = JSON.parse(line) as WorkerResponse;
      if ('error' in response) {
        request.reject(new Error(response.error));
      } else {
        request.resolve(response.result);
      }
    } catch (error) {
      request.reject(new Error('Invalid response from the Python step index.', { cause: error }));
    }
  }

  /** Stop the worker and release all callers waiting on it. */
  stop(error = new Error('Python step index stopped.')): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.child.kill();
    for (const request of this.pending.splice(0)) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
  }
}

export class StepIndex {
  private readonly workers = new Map<string, IndexWorker>();
  private readonly script: string;

  /** Locate the bundled Python analyzer in the installed extension. */
  constructor(extensionPath: string) {
    this.script = join(extensionPath, 'python', 'step_index.py');
  }

  /** Resolve queries using the worker for the selected Python interpreter. */
  resolve(interpreter: string, request: IndexRequest): Promise<StepIndexResult> {
    return this.worker(interpreter).request({ operation: 'resolve', ...request });
  }

  /** Validate a batch of feature steps and report whether discovery was complete. */
  diagnose(interpreter: string, request: IndexRequest): Promise<StepDiagnosticResult> {
    return this.worker(interpreter).request({ operation: 'diagnose', ...request });
  }

  /** List patterns available at an incomplete step in a feature. */
  complete(interpreter: string, request: {
    workspace: string;
    importPaths: string[];
    kind: StepQuery['kind'];
    prefix: string;
  } & SuiteLocation): Promise<{ items: StepSuggestion[]; incomplete: boolean }> {
    return this.worker(interpreter).request({ operation: 'complete', ...request });
  }

  /** Extract the selected literal execute_steps argument from the current editor buffer. */
  inspectPython(interpreter: string, request: PythonStepRequest): Promise<StepSnippet | null> {
    return this.worker(interpreter).request({ operation: 'inspectPython', ...request });
  }

  /** Find suites whose static imports reach the shared Python step caller. */
  findSuites(interpreter: string, request: SuiteRequest): Promise<string[]> {
    return this.worker(interpreter).request({ operation: 'findSuites', ...request });
  }

  /** Reuse the interpreter process while it remains available. */
  private worker(interpreter: string): IndexWorker {
    let worker = this.workers.get(interpreter);
    if (!worker?.available) {
      worker = new IndexWorker(interpreter, this.script);
      this.workers.set(interpreter, worker);
    }
    return worker;
  }

  /** Stop all index workers when VS Code deactivates the extension. */
  dispose(): void {
    for (const worker of this.workers.values()) {
      worker.stop();
    }
    this.workers.clear();
  }
}
