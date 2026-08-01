/**
 * Pure provider-routing and protocol helpers used by the localhost proxy.
 * Keep these helpers free of credentials and request/response content so they
 * can be covered with small synthetic fixtures.
 */

export function resolveVeniceUpstream(path) {
  const pathname = String(path || '');
  if (pathname !== '/venice' && !pathname.startsWith('/venice/')) return null;
  return {
    provider: 'venice',
    hostname: 'api.venice.ai',
    apiBase: '/api/v1',
    stripPrefix: '/venice',
  };
}

export function isOpenAICompatibleProvider(provider) {
  return provider === 'openai' || provider === 'venice';
}

export function buildUpstreamPath(upstream, pathname, search = '') {
  const forwardedPathname = upstream.stripPrefix && pathname.startsWith(upstream.stripPrefix)
    ? pathname.slice(upstream.stripPrefix.length)
    : pathname;
  return `${upstream.apiBase || ''}${forwardedPathname}${search || ''}`;
}

export function extractOpenAICompatibleUsage(data) {
  const response = data?.response || data || {};
  const usage = response.usage || {};
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ||
    usage.input_tokens_details?.cached_tokens || 0;

  return {
    inputTokens: usage.prompt_tokens || usage.input_tokens || 0,
    outputTokens: usage.completion_tokens || usage.output_tokens || 0,
    cachedTokens,
    cacheCreationTokens: usage.cache_write_tokens ||
      usage.input_tokens_details?.cache_write_tokens || 0,
    model: response.model || data?.model || '',
    requestId: response.id || data?.id || '',
  };
}
