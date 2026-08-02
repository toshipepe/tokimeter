import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'packages', 'proxy', 'src', 'cli.js');
const PRICING = join(HERE, '..', 'packages', 'core', 'src', 'pricing.js');
const TRACKER = join(HERE, '..', 'packages', 'core', 'src', 'tracker.js');

test('pricing provenance distinguishes verified, community, custom, and fallback', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tokimeter-pricing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const customFile = join(root, 'pricing.json');
  const feedFile = join(root, 'pricing-feed.json');

  writeFileSync(customFile, JSON.stringify({
    prices: [
      { provider: 'custom', model: 'local-model', input: 7, output: 9, cached: 1 },
    ],
  }));
  writeFileSync(feedFile, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    source: 'https://example.invalid/community-prices.json',
    prices: [
      { provider: 'openai', model: 'community-model', input: 3, output: 6, cached: 0.3 },
      { provider: 'openai', model: 'gpt-4.1', input: 99, output: 99, cached: 99 },
    ],
  }));

  const oldCustom = process.env.TOKIMETER_PRICING_FILE;
  const oldFeed = process.env.TOKIMETER_PRICING_FEED_FILE;
  process.env.TOKIMETER_PRICING_FILE = customFile;
  process.env.TOKIMETER_PRICING_FEED_FILE = feedFile;
  t.after(() => {
    if (oldCustom === undefined) delete process.env.TOKIMETER_PRICING_FILE;
    else process.env.TOKIMETER_PRICING_FILE = oldCustom;
    if (oldFeed === undefined) delete process.env.TOKIMETER_PRICING_FEED_FILE;
    else process.env.TOKIMETER_PRICING_FEED_FILE = oldFeed;
  });

  const nonce = `${Date.now()}-${Math.random()}`;
  const pricing = await import(`${pathToFileURL(PRICING).href}?test=${nonce}`);
  assert.deepEqual(
    {
      confidence: pricing.getPricingSource('gpt-4.1').confidence,
      source: pricing.getPricingSource('gpt-4.1').source,
    },
    { confidence: 'verified', source: 'built-in' },
  );
  assert.deepEqual(
    {
      confidence: pricing.getPricingSource('community-model').confidence,
      source: pricing.getPricingSource('community-model').source,
    },
    { confidence: 'community', source: 'community' },
  );
  assert.deepEqual(
    {
      confidence: pricing.getPricingSource('local-model').confidence,
      source: pricing.getPricingSource('local-model').source,
    },
    { confidence: 'custom', source: 'custom' },
  );
  assert.equal(pricing.getPricingSource('future-unknown-model').confidence, 'fallback');
  assert.deepEqual(
    {
      confidence: pricing.getPricingSource('codex-auto-review').confidence,
      source: pricing.getPricingSource('codex-auto-review').source,
      authoritative: pricing.getPricingSource('codex-auto-review').authoritative,
    },
    { confidence: 'fallback', source: 'internal', authoritative: false },
  );
});

test('current recorded model prices are sourced without guessing internal aliases', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tokimeter-current-models-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  process.env.TOKIMETER_PRICING_FILE = join(root, 'missing-custom.json');
  process.env.TOKIMETER_PRICING_FEED_FILE = join(root, 'missing-feed.json');
  t.after(() => {
    delete process.env.TOKIMETER_PRICING_FILE;
    delete process.env.TOKIMETER_PRICING_FEED_FILE;
  });

  const nonce = `${Date.now()}-${Math.random()}`;
  const pricing = await import(`${pathToFileURL(PRICING).href}?test=${nonce}`);
  const opus = pricing.priceCall('claude-opus-5', 1_000_000, 1_000_000, 500_000, 200_000, {
    cachedIncludedInInput: false,
  });

  assert.equal(opus.inputCost, 6.5);
  assert.equal(opus.outputCost, 25);
  assert.equal(opus.totalCost, 31.5);
  assert.equal(opus.pricingSource, 'verified');
  assert.equal(pricing.getPricingSource('claude-opus-5').source, 'built-in');

  const reviewer = pricing.priceCall('codex-auto-review', 1_000_000, 1_000_000);
  assert.equal(reviewer.totalCost, 0);
  assert.equal(reviewer.authoritative, false);
  assert.equal(reviewer.pricingSource, 'internal');
  assert.equal(pricing.getPricingSource('codex-auto-review').source, 'internal');
});

test('unknown fallback stays outside authoritative tracker totals', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tokimeter-pricing-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  process.env.TOKIMETER_PRICING_FILE = join(root, 'missing-custom.json');
  process.env.TOKIMETER_PRICING_FEED_FILE = join(root, 'missing-feed.json');
  t.after(() => {
    delete process.env.TOKIMETER_PRICING_FILE;
    delete process.env.TOKIMETER_PRICING_FEED_FILE;
  });

  const nonce = `${Date.now()}-${Math.random()}`;
  const pricing = await import(`${pathToFileURL(PRICING).href}?test=${nonce}`);
  const { CostTracker } = await import(`${pathToFileURL(TRACKER).href}?test=${nonce}`);
  const verified = pricing.priceCall('gpt-4.1', 1_000_000, 0);
  const unknown = pricing.priceCall('future-unknown-model', 1_000_000, 1_000_000);

  assert.equal(verified.totalCost, 2);
  assert.equal(verified.roughEstimateCost, 0);
  assert.equal(verified.pricingSource, 'verified');
  assert.equal(unknown.totalCost, 0);
  assert.equal(unknown.roughEstimateCost, 10);
  assert.equal(unknown.authoritative, false);

  const tracker = new CostTracker();
  const now = Date.now();
  tracker.record({ timestamp: now, model: 'gpt-4.1', tool: 'codex', totalCost: verified.totalCost });
  tracker.record({
    timestamp: now,
    model: 'future-unknown-model',
    tool: 'codex',
    totalCost: unknown.totalCost,
    roughEstimateCost: unknown.roughEstimateCost,
  });
  const summary = tracker.getSummary();
  assert.equal(summary.totalCost, 2);
  assert.equal(summary.roughEstimateCost, 10);
  assert.equal(summary.roughEstimateCalls, 1);
});

test('report JSON separates known totals from unknown-model rough estimates', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tokimeter-report-pricing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const claudeHome = join(root, '.claude');
  const projectDir = join(claudeHome, 'projects', 'synthetic-project');
  mkdirSync(projectDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const records = [
    {
      type: 'assistant',
      timestamp,
      cwd: '/workspace/synthetic-project',
      sessionId: 'synthetic-session',
      message: {
        id: 'known-price',
        model: 'claude-haiku-4-5',
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      },
    },
    {
      type: 'assistant',
      timestamp,
      cwd: '/workspace/synthetic-project',
      sessionId: 'synthetic-session',
      message: {
        id: 'unknown-price',
        model: 'claude-future-unknown',
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      },
    },
  ];
  writeFileSync(join(projectDir, 'synthetic-session.jsonl'), `${records.map(JSON.stringify).join('\n')}\n`);

  const output = execFileSync(process.execPath, [CLI, 'report', '--days=1', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      CLAUDE_HOME: claudeHome,
      CODEX_HOME: join(root, '.codex'),
      CURSOR_HOME: join(root, '.cursor'),
      GROK_HOME: join(root, '.grok'),
      HERMES_HOME: join(root, '.hermes'),
      TOKIMETER_DATA_DIR: join(root, '.tokimeter'),
      TOKIMETER_PRICING_FILE: join(root, '.tokimeter', 'pricing.json'),
      TOKIMETER_PRICING_FEED_FILE: join(root, '.tokimeter', 'pricing-feed.json'),
    },
  });
  const report = JSON.parse(output);
  assert.equal(report.totals.cost, 1);
  assert.equal(report.totals.roughEstimateCost, 10);
  assert.equal(report.totals.unpricedCalls, 1);
  assert.equal(report.pricingSources.find((row) => row.name === 'verified built-in').cost, 1);
  assert.equal(report.pricingSources.find((row) => row.name === 'fallback / unpriced').roughEstimateCost, 10);
});
