'use strict';

const { AiProviderError } = require('../providers.errors');

const FINISH = Object.freeze({ stop: 'stop', length: 'length', tool_calls: 'tool_calls', function_call: 'tool_calls' });

/** Pedido comum -> corpo de chat/completions. */
function buildChatBody(request, entry) {
  const messages = [];
  if (request.system) messages.push({ role: 'system', content: String(request.system) });
  (request.messages || []).filter((m) => m && ['user', 'assistant'].includes(m.role)).forEach((m) => messages.push({ role: m.role, content: String(m.content ?? '') }));
  const body = {
    model: entry.model,
    messages,
    temperature: request.temperature ?? 0,
    max_completion_tokens: Number.isInteger(request.maxOutputTokens) && request.maxOutputTokens > 0 ? request.maxOutputTokens : entry.maxOutputTokens,
  };
  if (Array.isArray(request.tools) && request.tools.length) {
    body.tools = request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } } }));
  }
  if (request.responseSchema) body.response_format = { type: 'json_schema', json_schema: { name: 'resposta', schema: request.responseSchema } };
  return body;
}

function parseArguments(raw) {
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}

/** Resposta de chat/completions -> formato comum. Filtro de conteúdo vira SAFETY_BLOCKED. */
function parseChatResponse(json, providerCode) {
  const choice = (json && Array.isArray(json.choices) && json.choices[0]) || {};
  if (choice.finish_reason === 'content_filter') throw new AiProviderError('SAFETY_BLOCKED', { providerCode, upstreamCode: 'content_filter' });
  const message = choice.message || {};
  const usage = (json && json.usage) || {};
  return {
    text: typeof message.content === 'string' ? message.content : '',
    toolRequests: (message.tool_calls || []).map((c) => ({ name: c.function && c.function.name, arguments: parseArguments(c.function && c.function.arguments) })),
    usage: { tokensIn: Number(usage.prompt_tokens) || 0, tokensOut: Number(usage.completion_tokens) || 0 },
    finishReason: FINISH[choice.finish_reason] || 'stop',
    providerRequestId: String((json && json.id) || ''),
  };
}

/** Resposta de embeddings -> { vectors, dimensions, usage }. Quantidade diferente de entradas é erro (nunca devolve vetor faltando). */
function parseEmbedResponse(json, expected, providerCode) {
  const data = Array.isArray(json && json.data) ? [...json.data].sort((a, b) => (a.index || 0) - (b.index || 0)) : [];
  const vectors = data.map((d) => d.embedding);
  const dimensions = vectors.length ? vectors[0].length : 0;
  if (vectors.length !== expected || vectors.some((v) => !Array.isArray(v) || v.length !== dimensions)) {
    throw new AiProviderError('UNKNOWN', { providerCode, upstreamCode: 'EMBED_SHAPE' });
  }
  const usage = (json && json.usage) || {};
  return { vectors, dimensions, usage: { tokensIn: Number(usage.prompt_tokens) || 0, tokensOut: 0 }, providerRequestId: String((json && json.id) || '') };
}

module.exports = { buildChatBody, parseChatResponse, parseEmbedResponse };
