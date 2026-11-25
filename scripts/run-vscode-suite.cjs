const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

/** Run the extension integration tests in an isolated VS Code instance. */
async function run() {
  const root = mkdtempSync(join(tmpdir(), 'toolium-vscode-tests-'));
  let passed = false;
  try {
    const userData = join(root, 'user');
    const workspace = join(root, 'workspace');
    mkdirSync(join(userData, 'User'), { recursive: true });
    mkdirSync(workspace);
    // Isolate user settings and trust only the synthetic workspace used by the tests.
    writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify({
      'security.workspace.trust.enabled': false,
      'workbench.startupEditor': 'none'
    }));
    const result = spawnSync(process.env.VSCODE_EXECUTABLE || 'code', [
      '--disable-extensions',
      '--user-data-dir', userData,
      '--extensions-dir', join(root, 'extensions'),
      '--extensionDevelopmentPath', resolve(__dirname, '..'),
      '--extensionTestsPath', join(__dirname, 'vscode-suite.cjs'),
      workspace
    ], { stdio: 'inherit', timeout: 60_000 });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`VS Code exited with status ${result.status}.`);
    }
    // Some VS Code launchers return before the extension host runs its tests.
    const success = join(workspace, '.passed');
    const failure = join(workspace, '.failed');
    const deadline = Date.now() + 60_000;
    while (!existsSync(success)) {
      if (existsSync(failure)) {
        throw new Error(readFileSync(failure, 'utf8'));
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the VS Code extension tests.');
      }
      await delay(100);
    }
    passed = true;
    console.log('Extension tests passed in VS Code.');
  } finally {
    if (passed) {
      rmSync(root, { recursive: true, force: true });
    } else {
      console.error(`VS Code test files and logs were preserved in ${root}.`);
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
