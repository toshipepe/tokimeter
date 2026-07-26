#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = path.join(repoRoot, 'ts', 'packages', 'proxy');
const mode = process.argv[2] ?? '--ci';

const EXPECTED_NPM_USER = 'toshipepe';
const EXPECTED_PUBLIC_EMAIL = 'npm@toshipepe.com';
const EXPECTED_AUTHOR = Object.freeze({
  name: 'ToshiPepe',
  url: 'https://github.com/toshipepe',
});
const EXPECTED_PACKAGE_FILES = Object.freeze([
  'LICENSE',
  'README.md',
  'package.json',
  'src/cli.js',
  'src/cloud-sync.js',
  'src/core/index.js',
  'src/core/pace.mjs',
  'src/core/pricing.js',
  'src/core/tracker.js',
  'src/parsers.js',
  'src/server.js',
]);

const ALLOWED_EXAMPLE_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.net',
  'example.org',
]);
const ALLOWED_SYNTHETIC_USERNAMES = new Set([
  'demo',
  'dev',
  'example',
  'private',
  'someone',
  'x',
]);
const FORBIDDEN_TRACKED_PREFIXES = [
  '.agents/',
  '.codex/',
  '.cursor/',
  '.local/',
];
const FORBIDDEN_TRACKED_BASENAMES = new Set([
  '.dev.vars',
  '.npmrc',
  'credentials.json',
]);

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi;
const POSIX_USER_PATH_PATTERN = /(?<![A-Z0-9._-])\/(?:Users|home)\/([^/\\\s"'`]+)/gi;
const WINDOWS_USER_PATH_PATTERN = /(?<![A-Z0-9._-])[A-Z]:\\Users\\([^\\\s"'`]+)/gi;
const SECRET_PATTERNS = [
  ['private key', /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i],
  ['npm access token', /\bnpm_[A-Z0-9]{20,}\b/i],
  ['GitHub access token', /\bgh[Pousr]_[A-Z0-9]{20,}\b/i],
  ['OpenAI-style secret key', /\bsk-(?:proj-)?[A-Z0-9_-]{20,}\b/i],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Z_-]{30,}\b/i],
  ['GitLab access token', /\bglpat-[0-9A-Z_-]{20,}\b/i],
  ['Slack access token', /\bxox[Baprs]-[0-9A-Z-]{20,}\b/i],
  ['Stripe live key', /\b(?:sk|rk)_live_[0-9A-Z]{16,}\b/i],
  ['JWT', /\beyJ[A-Z0-9_-]{20,}\.[A-Z0-9_-]{20,}\.[A-Z0-9_-]{20,}\b/i],
];
const GENERIC_CREDENTIAL_PATTERN = /\b(?:api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["']([A-Z0-9_./+=-]{16,})["']/gi;
const SAFE_CREDENTIAL_MARKERS = /(?:dummy|example|placeholder|redacted|test|your[_-])/i;

const failures = [];
const notes = [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    env: { ...process.env, ...options.env },
    input: options.input,
    maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function git(args, options = {}) {
  return run('git', args, options).stdout.trim();
}

function isAllowedGitEmail(email) {
  const normalized = email.trim().toLowerCase();
  return normalized === EXPECTED_PUBLIC_EMAIL
    || normalized === 'noreply@github.com'
    || normalized.endsWith('@users.noreply.github.com');
}

function isAllowedContentEmail(email, domain) {
  return isAllowedGitEmail(email)
    || ALLOWED_EXAMPLE_EMAIL_DOMAINS.has(domain.toLowerCase());
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function scanText(label, text) {
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    if (!isAllowedContentEmail(match[0], match[1])) {
      failures.push(`${label}:${lineNumberAt(text, match.index)} contains an unapproved email address`);
    }
  }

  for (const pattern of [POSIX_USER_PATH_PATTERN, WINDOWS_USER_PATH_PATTERN]) {
    for (const match of text.matchAll(pattern)) {
      if (!ALLOWED_SYNTHETIC_USERNAMES.has(match[1].toLowerCase())) {
        failures.push(`${label}:${lineNumberAt(text, match.index)} contains a non-synthetic user directory path`);
      }
    }
  }

  for (const [name, pattern] of SECRET_PATTERNS) {
    const match = pattern.exec(text);
    if (match) failures.push(`${label}:${lineNumberAt(text, match.index)} contains a possible ${name}`);
  }

  for (const match of text.matchAll(GENERIC_CREDENTIAL_PATTERN)) {
    if (!SAFE_CREDENTIAL_MARKERS.test(match[1])) {
      failures.push(`${label}:${lineNumberAt(text, match.index)} contains a possible hard-coded credential`);
    }
  }
}

function scanBuffer(label, buffer) {
  if (buffer.includes(0)) return;
  scanText(label, buffer.toString('utf8'));
}

function trackedFiles() {
  return git(['ls-files', '-z']).split('\0').filter(Boolean);
}

function checkTrackedTree() {
  const files = trackedFiles();
  for (const relativePath of files) {
    scanText(`path:${relativePath}`, relativePath);
    if (FORBIDDEN_TRACKED_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) {
      failures.push(`${relativePath} is a private local-workspace path and must not be tracked`);
    }
    if (FORBIDDEN_TRACKED_BASENAMES.has(path.basename(relativePath))) {
      failures.push(`${relativePath} is a credential-bearing filename and must not be tracked`);
    }
    const absolutePath = path.join(repoRoot, relativePath);
    if (existsSync(absolutePath) && statSync(absolutePath).isFile()) {
      scanBuffer(relativePath, readFileSync(absolutePath));
    }
  }

  const stagedFiles = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
    .split('\0')
    .filter(Boolean);
  for (const relativePath of stagedFiles) {
    const staged = run('git', ['show', `:${relativePath}`], { allowFailure: true });
    if (staged.status === 0) scanText(`staged:${relativePath}`, staged.stdout);
  }
  notes.push(`${files.length} tracked files scanned`);
}

function checkGitHistory() {
  const objectLines = git(['rev-list', '--objects', '--all'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const historicalObjects = [];
  const seen = new Set();

  for (const line of objectLines) {
    const separator = line.indexOf(' ');
    if (separator < 0) continue;
    const objectId = line.slice(0, separator);
    const historicalPath = line.slice(separator + 1);
    scanText(`historical-path:${historicalPath}`, historicalPath);
    if (FORBIDDEN_TRACKED_PREFIXES.some((prefix) => historicalPath.startsWith(prefix))) {
      failures.push(`${historicalPath} existed in reachable Git history as a private local-workspace path`);
    }
    if (FORBIDDEN_TRACKED_BASENAMES.has(path.basename(historicalPath))) {
      failures.push(`${historicalPath} existed in reachable Git history as a credential-bearing filename`);
    }
    if (!seen.has(objectId)) {
      seen.add(objectId);
      historicalObjects.push({ objectId, historicalPath });
    }
  }

  if (!historicalObjects.length) {
    notes.push('0 reachable Git history objects scanned');
    return;
  }

  const batch = run('git', ['cat-file', '--batch'], {
    env: {},
    input: historicalObjects.map(({ objectId }) => objectId).join('\n') + '\n',
    encoding: null,
  }).stdout;
  let offset = 0;
  let scanned = 0;

  for (const { objectId, historicalPath } of historicalObjects) {
    const newline = batch.indexOf(0x0a, offset);
    if (newline < 0) throw new Error('git history scan received a truncated object header');
    const header = batch.subarray(offset, newline).toString('utf8');
    const parts = header.split(' ');
    if (parts[0] !== objectId || parts[1] === 'missing') {
      throw new Error('git history scan could not resolve a reachable object');
    }
    const size = Number(parts[2]);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error('git history scan received an invalid object size');
    }
    const contentStart = newline + 1;
    const contentEnd = contentStart + size;
    if (contentEnd > batch.length) throw new Error('git history scan received truncated object content');
    scanBuffer(`history:${historicalPath}@${objectId.slice(0, 12)}`, batch.subarray(contentStart, contentEnd));
    scanned += 1;
    offset = contentEnd + 1;
  }

  notes.push(`${scanned} reachable Git history objects scanned`);
}

function checkGitIdentity() {
  const commitEmails = git(['log', '--all', '--format=%ae'])
    .split('\n')
    .map((email) => email.trim())
    .filter(Boolean);
  const rejected = [...new Set(commitEmails.filter((email) => !isAllowedGitEmail(email)))];
  if (rejected.length) {
    failures.push(`${rejected.length} reachable Git commit email(s) are not GitHub noreply or the approved brand address`);
  }

  const trustedPublisher = mode === '--prepublish' && process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  if (mode !== '--ci' && !trustedPublisher) {
    const configuredEmail = git(['config', 'user.email'], { allowFailure: true });
    if (!configuredEmail || !isAllowedGitEmail(configuredEmail)) {
      failures.push('the configured Git author email is not GitHub noreply or the approved brand address');
    }
  }
  notes.push(`${commitEmails.length} reachable Git commit identities checked`);
}

function walkFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(absolutePath));
    else if (entry.isFile()) result.push(absolutePath);
  }
  return result;
}

function checkPackage() {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  if (manifest.author?.name !== EXPECTED_AUTHOR.name
      || manifest.author?.url !== EXPECTED_AUTHOR.url
      || manifest.author?.email) {
    failures.push('npm author metadata must contain only the approved ToshiPepe name and GitHub URL');
  }
  if (JSON.stringify(manifest.files) !== JSON.stringify(['src', 'README.md', 'LICENSE'])) {
    failures.push('npm files allowlist changed from the approved src/README/LICENSE policy');
  }

  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'tokimeter-privacy-'));
  try {
    const packResult = run('npm', [
      'pack',
      '--json',
      '--pack-destination', temporaryDirectory,
      '--cache', path.join(temporaryDirectory, 'npm-cache'),
    ], {
      cwd: packageDir,
      env: {
        NPM_CONFIG_DRY_RUN: 'false',
        npm_config_dry_run: 'false',
      },
    });
    const pack = JSON.parse(packResult.stdout)[0];
    const actualFiles = pack.files.map((file) => file.path).sort();
    const expectedFiles = [...EXPECTED_PACKAGE_FILES].sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
      const added = actualFiles.filter((file) => !expectedFiles.includes(file));
      const missing = expectedFiles.filter((file) => !actualFiles.includes(file));
      if (added.length) failures.push(`npm tarball has unexpected files: ${added.join(', ')}`);
      if (missing.length) failures.push(`npm tarball is missing approved files: ${missing.join(', ')}`);
    }

    const extractDirectory = path.join(temporaryDirectory, 'extracted');
    mkdirSync(extractDirectory);
    run('tar', ['-xzf', path.join(temporaryDirectory, pack.filename), '-C', extractDirectory]);
    const extractedRoot = path.join(extractDirectory, 'package');
    for (const absolutePath of walkFiles(extractedRoot)) {
      const relativePath = path.relative(extractedRoot, absolutePath);
      scanBuffer(`npm:${relativePath}`, readFileSync(absolutePath));
    }
    notes.push(`${actualFiles.length} exact npm tarball files scanned`);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function checkNpmIdentity() {
  const profileResult = run('npm', [
    'profile',
    'get',
    'email',
    '--json',
    '--registry=https://registry.npmjs.org',
  ], { cwd: packageDir });
  const profile = JSON.parse(profileResult.stdout);
  if (profile.name !== EXPECTED_NPM_USER
      || profile.email !== EXPECTED_PUBLIC_EMAIL
      || profile.email_verified !== true) {
    failures.push('authenticated npm profile does not match the verified ToshiPepe publishing identity');
  }
  if (profile.tfa?.mode !== 'auth-and-writes') {
    failures.push('npm two-factor authentication must protect authentication and writes');
  }
  notes.push('verified npm publisher identity and write-protected 2FA');
}

function checkPrepublishState() {
  const trackedChanges = git(['status', '--porcelain', '--untracked-files=no']);
  if (trackedChanges) failures.push('tracked working tree is dirty; publish only from a committed release');

  const head = git(['rev-parse', 'HEAD']);
  const originMain = git(['rev-parse', 'origin/main'], { allowFailure: true });
  if (!originMain || head !== originMain) {
    failures.push('release commit must exactly match origin/main before publishing');
  }

  const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const viewResult = run('npm', [
    'view',
    `${manifest.name}@${manifest.version}`,
    'version',
    '--json',
    '--registry=https://registry.npmjs.org',
  ], { cwd: packageDir, allowFailure: true });
  if (viewResult.status === 0) {
    failures.push(`${manifest.name}@${manifest.version} already exists on npm; bump the version first`);
  } else if (!/E404|not found/i.test(`${viewResult.stdout}\n${viewResult.stderr}`)) {
    failures.push('could not verify npm version availability');
  }

  if (process.env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    notes.push('GitHub OIDC trusted-publishing environment detected');
  } else {
    checkNpmIdentity();
  }
}

function runSelfTest() {
  const originalFailureCount = failures.length;
  const badEmail = ['person', 'gmail.com'].join('@');
  const badPath = ['', 'Users', 'real-person', 'private'].join('/');
  const badToken = ['npm', 'A'.repeat(24)].join('_');
  scanText('self-test', [badEmail, badPath, badToken].join('\n'));
  const detected = failures.length - originalFailureCount;
  failures.splice(originalFailureCount);
  if (detected !== 3) failures.push(`privacy detector self-test expected 3 findings, received ${detected}`);
  scanText('self-test-safe', `${EXPECTED_PUBLIC_EMAIL}\nperson@example.com`);
  notes.push('privacy detector failure and allowlist cases tested');
}

try {
  if (mode === '--self-test') {
    runSelfTest();
  } else if (mode === '--identity') {
    checkGitIdentity();
    checkNpmIdentity();
  } else if (mode === '--ci' || mode === '--precommit' || mode === '--prepublish') {
    checkGitIdentity();
    checkTrackedTree();
    checkGitHistory();
    checkPackage();
    if (mode === '--prepublish') checkPrepublishState();
  } else {
    failures.push(`unknown mode: ${mode}`);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

if (failures.length) {
  console.error('Privacy gate failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Privacy gate passed:');
  for (const note of notes) console.log(`- ${note}`);
}
