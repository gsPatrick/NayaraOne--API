'use strict';

const { AiProviderError } = require('../providers.errors');

const FINISH = Object.freeze({ end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls' });
const ROLES = new Set(['user', 'assistant']);

/** Pedido comum -> corpo da API de mensagens. */
function buildMessagesBody(request, entry) {
  const schema = request.responseSchema ? `\n\nResponda somente com JSON válido que obedeça a este schema:\n${JSON.stringify(request.responseSchema)}` : '';
  const system = `${request.system || ''}${schema}`.trim();
  const body = {
    model: entry.model,
    max_tokens: Number.isInteger(request.maxOutputTokens) && request.maxOutputTokens > 0 ? request.maxOutputTokens : entry.maxOutputTokens,
    temperature: request.temperature ?? 0,
    messages: (request.messages || []).filter((m) => m && ROLES.has(m.role)).map((m) => ({ role: m.role, content: String(m.content ?? '') })),
  };
  if (system) body.system = system;
  if (Array.isArray(request.tools) && request.tools.length) {
    body.tools = request.tools.map((t) => ({ name: t.name, description: t.description || '', input_schema: t.inputSchema || { type: 'object', properties: {} } }));
  }
  return body;
}

/** Resposta da API -> { text, toolRequests, usage, finishReason, providerRequestId }. Recusa do modelo vira SAFETY_BLOCKED. */
function parseMessagesResponse(json, providerCode) {
  const blocks = Array.isArray(json && json.content) ? json.content : [];
  if (json && json.stop_reason === 'refusal') throw new AiProviderError('SAFETY_BLOCKED', { providerCode, upstreamCode: 'refusal' });
  const usage = (json && json.usage) || {};
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    toolRequests: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ name: b.name, arguments: b.input || {} })),
    usage: { tokensIn: Number(usage.input_tokens) || 0, tokensOut: Number(usage.output_tokens) || 0 },
    finishReason: FINISH[json && json.stop_reason] || 'stop',
    providerRequestId: String((json && json.id) || ''),
  };
}

module.exports = { buildMessagesBody, parseMessagesResponse };
