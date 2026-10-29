'use strict';

const { HttpModelAdapter } = require('../HttpModelAdapter');
const { AiProviderError } = require('../providers.errors');
const { buildMessagesBody, parseMessagesResponse } = require('./anthropic.mapper');

const CODE = 'anthropic';

/** Adapter real da Anthropic (API de mensagens). Só `generate`: o resto cai em AI_CAPABILITY_UNSUPPORTED. */
class AnthropicAdapter extends HttpModelAdapter {
  providerCode() { return CODE; }

  capabilities() { return ['generate']; }

  defaultBaseUrl() { return 'https://api.anthropic.com'; }

  healthPath() { return '/v1/models'; }

  authHeaders(key) { return { 'x-api-key': key, 'anthropic-version': String(this.config().providerApiVersion || '2023-06-01') }; }

  async generate(request = {}) {
    const entry = this.modelEntry(request.model, 'generate');
    if (request.responseSchema && !entry.structuredOutput) throw new AiProviderError('VALIDATION', { providerCode: CODE, upstreamCode: 'STRUCTURED_OUTPUT_UNSUPPORTED' });
    if (Array.isArray(request.tools) && request.tools.length && !entry.toolUse) throw new AiProviderError('VALIDATION', { providerCode: CODE, upstreamCode: 'TOOL_USE_UNSUPPORTED' });
    const key = await this.apiKey();
    const { json, latencyMs } = await this.postJson('/v1/messages', buildMessagesBody(request, entry), { key, timeoutMs: request.timeoutMs, idempotencyKey: request.idempotencyKey });
    const out = parseMessagesResponse(json, CODE);
    return { ...out, costAmount: this.costFor(entry, out.usage), latencyMs, model: entry.model };
  }
}

module.exports = { AnthropicAdapter, CODE };
