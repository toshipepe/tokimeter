import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'packages', 'proxy', 'src', 'cli.js');
const PACKAGE_JSON = join(HERE, '..', 'packages', 'proxy', 'package.json');
const STAGED_WORKFLOW = join(HERE, '..', '..', '.github', 'workflows', 'npm-staged-publish.yml');
const RELEASE_DOC = join(HERE, '..', '..', 'docs', 'RELEASING.md');

function isolatedEnv(root) {
  return {
    ...process.env,
    HOME: root,
    SHELL: '/bin/zsh',
    CODEX_HOME: join(root, '.codex'),
    CLAUDE_HOME: join(root, '.claude'),
    CURSOR_HOME: join(root, '.cursor'),
    GROK_HOME: join(root, '.grok'),
    HERMES_HOME: join(root, '.hermes'),
    TOKIMETER_DATA_DIR: join(root, '.tokimeter'),
    TOKIMETER_PRICING_FILE: join(root, '.tokimeter', 'pricing.json'),
    TOKIMETER_PRICING_FEED_FILE: join(root, '.tokimeter', 'pricing-feed.json'),
    TOKIMETER_PTY: '0',
  };
}

function tree(root) {
  const result = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      result.push(path.slice(root.length + 1));
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
  return result.sort();
}

function fakeNpmEnv(root, { installStatus = 0, includeInstalledCli = true } = {}) {
  const binDir = join(root, 'fake-bin');
  const globalRoot = join(root, 'fake-global', 'lib', 'node_modules');
  const logFile = join(root, 'install-commands.jsonl');
  const npmPath = join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const fakeNpmScript = join(binDir, 'fake-npm.mjs');
  const installedCli = join(globalRoot, 'tokimeter', 'src', 'cli.js');
  mkdirSync(binDir, { recursive: true });

  if (includeInstalledCli) {
    mkdirSync(dirname(installedCli), { recursive: true });
    writeFileSync(installedCli, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ command: 'installed-cli', args: process.argv.slice(2) }) + '\\n');
`);
  }

  const fakeNpm = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ command: 'npm', args }) + '\\n');
if (args[0] === 'install') process.exit(${installStatus});
if (args[0] === 'root' && args[1] === '--global') {
  console.log(${JSON.stringify(globalRoot)});
  process.exit(0);
}
process.exit(2);
`;
  writeFileSync(fakeNpmScript, fakeNpm, { mode: 0o755 });
  if (process.platform === 'win32') {
    writeFileSync(npmPath, `@"${process.execPath}" "${fakeNpmScript}" %*\r\n`);
  } else {
    writeFileSync(npmPath, fakeNpm, { mode: 0o755 });
  }

  return {
    env: {
      ...isolatedEnv(root),
      PATH: `${binDir}${delimiter}${process.env.PATH || ''}`,
    },
    logFile,
  };
}

test('setup --dry-run prints exact plan and performs no mutation', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tokimeter-setup-dry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = tree(root);
  const output = execFileSync(process.execPath, [CLI, 'setup', '--auto', '--dry-run'], {
    encoding: 'utf8',
    env: isolatedEnv(root),
  });

  assert.match(output, /Tokimeter Setup Dry Run/);
  assert.match(output, new RegExp(join(root, '.codex', 'tokimeter.config.toml').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(output, new RegExp(join(root, '.claude', 'settings.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(output, new RegExp(join(root, '.tokimeter', 'bin', 'codex').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(output, /No files, processes, or settings were changed/);
  assert.match(output, /tokimeter uninstall/);
  assert.deepEqual(tree(root), before);
});

test('install pins the running package version and delegates to stable global setup', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tokimeter-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { env, logFile } = fakeNpmEnv(root);
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));

  const output = execFileSync(process.execPath, [CLI, 'install'], {
    encoding: 'utf8',
    env,
  });
  const commands = readFileSync(logFile, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));

  assert.match(output, /Tokimeter Install/);
  assert.match(output, /Tokimeter is installed/);
  assert.deepEqual(commands, [
    { command: 'npm', args: ['install', '--global', `tokimeter@${pkg.version}`] },
    { command: 'npm', args: ['root', '--global'] },
    { command: 'installed-cli', args: ['setup', '--auto'] },
  ]);
});

test('install dry-run performs no package or setup command', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tokimeter-install-dry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { env, logFile } = fakeNpmEnv(root, { includeInstalledCli: false });

  const output = execFileSync(process.execPath, [CLI, 'install', '--dry-run'], {
    encoding: 'utf8',
    env,
  });

  assert.match(output, /Tokimeter Install Dry Run/);
  assert.match(output, /No packages, files, processes, or settings were changed/);
  assert.equal(existsSync(logFile), false);
});

test('install stops before setup when npm global install fails', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tokimeter-install-fail-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { env, logFile } = fakeNpmEnv(root, { installStatus: 42, includeInstalledCli: false });

  const result = spawnSync(process.execPath, [CLI, 'install'], {
    encoding: 'utf8',
    env,
  });
  const commands = readFileSync(logFile, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));

  assert.equal(result.status, 42);
  assert.match(result.stderr, /could not install the stable runtime/);
  assert.deepEqual(commands, [
    { command: 'npm', args: ['install', '--global', `tokimeter@${JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')).version}`] },
  ]);
});

test('setup plan is shown before mutation and uninstall restores prior configs', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tokimeter-setup-restore-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = isolatedEnv(root);
  mkdirSync(env.CODEX_HOME, { recursive: true });
  mkdirSync(env.CLAUDE_HOME, { recursive: true });

  const apiProfile = join(env.CODEX_HOME, 'tokimeter.config.toml');
  const chatgptProfile = join(env.CODEX_HOME, 'tokimeter-chatgpt.config.toml');
  const claudeSettings = join(env.CLAUDE_HOME, 'settings.json');
  const priorApi = '# user-owned synthetic profile\nmodel = "example"\n';
  const priorChatgpt = '# user-owned synthetic subscription profile\n';
  const priorClaude = {
    statusLine: { type: 'command', command: 'synthetic-status-command' },
    spinnerVerbs: { mode: 'append', verbs: ['Synthetic'] },
    unrelated: true,
  };
  writeFileSync(apiProfile, priorApi);
  writeFileSync(chatgptProfile, priorChatgpt);
  writeFileSync(claudeSettings, `${JSON.stringify(priorClaude, null, 2)}\n`);

  const setupOutput = execFileSync(process.execPath, [CLI, 'setup'], { encoding: 'utf8', env });
  assert.ok(setupOutput.indexOf('Tokimeter Setup Plan') < setupOutput.indexOf('Codex API-key profile written'));
  assert.match(setupOutput, /Revert setup changes with: tokimeter uninstall/);
  assert.match(readFileSync(apiProfile, 'utf8'), /Generated by Tokimeter/);
  assert.match(JSON.parse(readFileSync(claudeSettings, 'utf8')).statusLine.command, /claude-statusline\.mjs/);

  const uninstallOutput = execFileSync(process.execPath, [CLI, 'uninstall'], { encoding: 'utf8', env });
  assert.match(uninstallOutput, /Restored prior Codex profiles/);
  assert.match(uninstallOutput, /Restored Claude status line/);
  assert.equal(readFileSync(apiProfile, 'utf8'), priorApi);
  assert.equal(readFileSync(chatgptProfile, 'utf8'), priorChatgpt);
  assert.deepEqual(JSON.parse(readFileSync(claudeSettings, 'utf8')), priorClaude);
  assert.equal(existsSync(join(env.TOKIMETER_DATA_DIR, 'codex-profiles-prev.json')), false);
  assert.equal(existsSync(join(env.TOKIMETER_DATA_DIR, 'claude-statusline.mjs')), false);
  assert.equal(existsSync(join(env.TOKIMETER_DATA_DIR, 'claude-statusline-prev.json')), false);
});

test('npm package has no install hooks and release workflow is stage-only', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  assert.equal(Object.hasOwn(pkg.scripts || {}, 'install'), false);
  assert.equal(Object.hasOwn(pkg.scripts || {}, 'postinstall'), false);

  const workflow = readFileSync(STAGED_WORKFLOW, 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /npm stage publish/);
  assert.match(workflow, /parts\[1\] > 15/);
  assert.match(workflow, /npm 11\.15\.0 or newer is required for staged trusted publishing/);
  assert.doesNotMatch(workflow, /\bnpm publish\b/);

  const releaseDoc = readFileSync(RELEASE_DOC, 'utf8');
  assert.match(releaseDoc, /npm 11\.15\.0\+/);
  assert.match(releaseDoc, /Require two-factor authentication and\s+disallow tokens/);
  assert.match(releaseDoc, /workflow ref and the `tag` input/);
});
