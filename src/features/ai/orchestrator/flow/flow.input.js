'use strict';

const crypto = require('node:crypto');
const E = require('./flow.errors');

// Teto técnico contra abuso (igual ao máximo do parâmetro ia.run.entrada_max_caracteres); o limite da empresa é conferido na rota, antes de existir run.
const INPUT_MAX = 100000;
const DEFAULT_TASK = 'consulta';

/** Entrada do passo 1: finalidade e pedido obrigatórios (sem finalidade o run nem é criado). */
function parseRunInput(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const purpose = typeof data.purpose === 'string' ? data.purpose.trim() : '';
  if (!purpose) throw E.purposeRequired();
  const input = typeof data.input === 'string' ? data.input : '';
  if (!input.trim() || input.length > INPUT_MAX) throw E.inputRequired();
  return {
    agentCode: String(data.agentCode || '').trim(),
    purpose,
    input,
    taskType: typeof data.taskType === 'string' && data.taskType.trim() ? data.taskType.trim() : DEFAULT_TASK,
    idempotencyKey: typeof data.idempotencyKey === 'string' && data.idempotencyKey.trim() ? data.idempotencyKey.trim() : null,
    correlationId: data.correlationId || null,
    conversationId: typeof data.conversationId === 'string' && data.conversationId ? data.conversationId : null,
    history: Array.isArray(data.history) ? data.history.filter((h) => h && typeof h.content === 'string' && h.content).map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })) : [],
    requiredCapabilities: Array.isArray(data.requiredCapabilities) ? data.requiredCapabilities.filter((c) => typeof c === 'string') : [],
    snapshotAt: data.snapshotAt || null,
    subject: data.subject && typeof data.subject === 'object' && typeof data.subject.type === 'string' && data.subject.id !== undefined ? { type: data.subject.type, id: String(data.subject.id) } : undefined,
  };
}

/** Hash do pedido (sha256 do JSON canônico do que define a consulta): a mesma chave com outro pedido é 409. */
function requestHashOf(parsed) {
  const canonical = JSON.stringify({ agentCode: parsed.agentCode.toUpperCase(), purpose: parsed.purpose, input: parsed.input, taskType: parsed.taskType });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** Estimativa de tokens (4 caracteres por token, teto para cima): serve ao roteador antes de haver a medida real do provedor. */
const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

module.exports = { parseRunInput, requestHashOf, estimateTokens, DEFAULT_TASK };
