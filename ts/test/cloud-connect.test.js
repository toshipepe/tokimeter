import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cliPath = resolve('packages/proxy/src/cli.js');

test('connect defaults to the first-party activation route', async () => {
  const source = await readFile(cliPath, 'utf8');
  assert.match(source, /https:\/\/tokimeter\.com\/api\/device-connect/);
  assert.doesNotMatch(source, /\.supabase\.co\/functions\/v1\/device-connect/);
});

test('connect exchanges a one-time code, protects the key, and backfills metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tokimeter-connect-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const privateKey = 'tmk_live_test-secret-never-print';
  const received = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || '{}');
    received.push({ path: req.url, authorization: req.headers.authorization, payload });
    res.setHeader('Content-Type', 'application/json');
    if (payload.action === 'exchange') {
      res.end(JSON.stringify({
        api_key: privateKey,
        ingest_url: `http://127.0.0.1:${server.address().port}/ingest`,
        device: { name: 'Test Mac' },
      }));
      return;
    }
    res.statusCode = 201;
    res.end(JSON.stringify({ ok: true, accepted: payload.events?.length || 0 }));
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));

  await writeFile(join(root, 'calls.jsonl'), JSON.stringify({
    externalId: 'proxy-test-1',
    timestamp: Date.now(),
    provider: 'openai',
    model: 'gpt-test',
    tool: 'codex-api',
    source: 'tokimeter-proxy',
    inputTokens: 10,
    outputTokens: 2,
    totalCost: 0.001,
    project: '/Users/someone/Desktop/private-project',
    prompt: 'must not sync',
  }) + '\n');

  const env = {
    ...process.env,
    HOME: root,
    TOKIMETER_DATA_DIR: root,
    CODEX_HOME: join(root, 'codex'),
    CLAUDE_HOME: join(root, 'claude'),
    GROK_HOME: join(root, 'grok'),
    HERMES_HOME: join(root, 'hermes'),
    CURSOR_HOME: join(root, 'cursor'),
    OPENCODE_DATA_DIR: join(root, 'opencode'),
    CLINE_DATA_DIR: join(root, 'cline'),
  };
  const code = 'tmc_abcdefghijklmnopqrstuvwxyz123456';
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cliPath,
    'connect',
    code,
    `--url=http://127.0.0.1:${server.address().port}/device-connect`,
    '--no-restart',
  ], { env });

  assert.doesNotMatch(stdout + stderr, new RegExp(privateKey));
  const settings = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'));
  assert.equal(settings.cloud.apiKey, privateKey);
  assert.equal(settings.cloud.projectMode, 'basename');
  assert.equal((await stat(join(root, 'settings.json'))).mode & 0o777, 0o600);

  assert.equal(received.length, 2);
  assert.equal(received[0].payload.action, 'exchange');
  assert.equal(received[1].authorization, `Bearer ${privateKey}`);
  assert.equal(received[1].payload.events.length, 1);
  assert.equal(received[1].payload.contract_version, 1);
  assert.equal(received[1].payload.events[0].contract_version, 1);
  assert.equal(received[1].payload.events[0].project, 'private-project');
  assert.equal(received[1].payload.events[0].prompt, undefined);
});
