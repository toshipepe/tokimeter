import test from 'node:test';
import assert from 'node:assert/strict';
import { getPricingSource } from '../packages/core/src/pricing.js';

import {
  buildUpstreamPath,
  extractOpenAICompatibleUsage,
  extractProviderRequestId,
  isOpenAICompatibleProvider,
  pricingModelKey,
  resolveVeniceUpstream,
} from '../packages/proxy/src/provider-protocol.js';

test('Venice route is fixed to the official API and does not catch lookalike paths', () => {
  assert.deepEqual(resolveVeniceUpstream('/venice/responses'), {
    provider: 'venice',
    hostname: 'api.venice.ai',
    apiBase: '/api/v1',
    stripPrefix: '/venice',
  });
  assert.deepEqual(resolveVeniceUpstream('/venice/chat/completions'), {
    provider: 'venice',
    hostname: 'api.venice.ai',
    apiBase: '/api/v1',
    stripPrefix: '/venice',
  });
  assert.equal(resolveVeniceUpstream('/venice-malicious/responses'), null);
  assert.equal(resolveVeniceUpstream('/v1/responses'), null);
});

test('Venice local routes preserve endpoints and queries under the fixed upstream base', () => {
  const upstream = resolveVeniceUpstream('/venice/responses');
  assert.equal(
    buildUpstreamPath(upstream, '/venice/responses', '?stream=true'),
    '/api/v1/responses?stream=true',
  );
  assert.equal(
    buildUpstreamPath(upstream, '/venice/chat/completions'),
    '/api/v1/chat/completions',
  );
});

test('Venice reuses OpenAI-compatible Responses API usage without content fields', () => {
  assert.equal(isOpenAICompatibleProvider('venice'), true);
  assert.equal(isOpenAICompatibleProvider('anthropic'), false);
  const usage = extractOpenAICompatibleUsage({
    id: 'resp_synthetic_001',
    model: 'synthetic-code-model',
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      input_tokens_details: {
        cached_tokens: 20,
      },
    },
  });

  assert.deepEqual(usage, {
    inputTokens: 120,
    outputTokens: 30,
    cachedTokens: 20,
    cacheCreationTokens: 0,
    model: 'synthetic-code-model',
  });
  assert.equal(Object.hasOwn(usage, 'input'), false);
  assert.equal(Object.hasOwn(usage, 'output'), false);
});

test('Venice chat-completion and wrapped stream-final usage stay compatible', () => {
  const chat = extractOpenAICompatibleUsage({
    id: 'chatcmpl_synthetic_001',
    model: 'synthetic-private-model',
    usage: {
      prompt_tokens: 80,
      completion_tokens: 25,
      prompt_tokens_details: {
        cached_tokens: 12,
        cache_creation_input_tokens: 7,
      },
    },
  });
  assert.deepEqual(chat, {
    inputTokens: 80,
    outputTokens: 25,
    cachedTokens: 12,
    cacheCreationTokens: 7,
    model: 'synthetic-private-model',
  });

  const wrapped = extractOpenAICompatibleUsage({
    type: 'response.completed',
    response: {
      id: 'resp_synthetic_002',
      model: 'synthetic-reasoning-model',
      usage: { input_tokens: 50, output_tokens: 40 },
    },
  });
  assert.deepEqual(wrapped, {
    inputTokens: 50,
    outputTokens: 40,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    model: 'synthetic-reasoning-model',
  });
});

test('Venice support request ID comes from CF-RAY, not response content', () => {
  assert.equal(
    extractProviderRequestId('venice', { 'cf-ray': 'synthetic-ray-id' }),
    'synthetic-ray-id',
  );
  assert.equal(extractProviderRequestId('venice', {}), '');
  assert.equal(extractProviderRequestId('openai', { 'cf-ray': 'not-venice' }), '');
});

test('Venice pricing keys cannot collide with another provider model ID', () => {
  assert.equal(pricingModelKey('venice', 'synthetic-shared-model'), 'venice:synthetic-shared-model');
  assert.equal(pricingModelKey('openai', 'synthetic-shared-model'), 'synthetic-shared-model');
  assert.notEqual(getPricingSource('claude-sonnet-5').confidence, 'fallback');
  assert.equal(getPricingSource(pricingModelKey('venice', 'claude-sonnet-5')).confidence, 'fallback');
});
