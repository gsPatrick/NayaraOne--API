'use strict';

const { HttpModelAdapter } = require('../HttpModelAdapter');
const { AiProviderError } = require('../providers.errors');
const { buildChatBody, parseChatResponse, parseEmbedResponse } = require('./openai.mapper');

const CODE = 'openai';

/** Adapter real da OpenAI (chat e embeddings). transcribe e analyzeImage caem em AI_CAPABILITY_UNSUPPORTED. */
class OpenAIAdapter extends HttpModelAdapter {
  providerCode() { return CODE; }

  capabilities() { return ['generate', 'embed']; }

  defaultBaseUrl() { return 'https://api.openai.com'; }

  healthPath() { return '/v1/models'; }

  authHeaders(key) { return { authorization: `Bearer ${key}` }; }

  async generate(request = {}) {
    const entry = this.modelEntry(request.model, 'generate');
    if (request.responseSchema && !entry.structuredOutput) throw new AiProviderError('VALIDATION', { providerCode: CODE, upstreamCode: 'STRUCTURED_OUTPUT_UNSUPPORTED' });
    if (Array.isArray(request.tools) && request.tools.length && !entry.toolUse) throw new AiProviderError('VALIDATION', { providerCode: CODE, upstreamCode: 'TOOL_USE_UNSUPPORTED' });
    const key = await this.apiKey();
    const { json, latencyMs } = await this.postJson('/v1/chat/completions', buildChatBody(request, entry), { key, timeoutMs: request.timeoutMs, idempotencyKey: request.idempotencyKey });
    const out = parseChatResponse(json, CODE);
    return { ...out, costAmount: this.costFor(entry, out.usage), latencyMs, model: entry.model };
  }

  async embed(request = {}) {
    const entry = this.modelEntry(request.model, 'embed');
    const inputs = Array.isArray(request.inputs) ? request.inputs : [];
    if (inputs.length === 0 || inputs.some((x) => typeof x !== 'string')) throw new AiProviderError('VALIDATION', { providerCode: CODE, upstreamCode: 'INPUTS_INVALID' });
    const key = await this.apiKey();
    const { json } = await this.postJson('/v1/embeddings', { model: entry.model, input: inputs }, { key, timeoutMs: request.timeoutMs, idempotencyKey: request.idempotencyKey });
    const out = parseEmbedResponse(json, inputs.length, CODE);
    return { ...out, costAmount: this.costFor(entry, out.usage) };
  }
}

module.exports = { OpenAIAdapter, CODE };
