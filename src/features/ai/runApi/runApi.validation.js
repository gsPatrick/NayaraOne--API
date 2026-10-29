'use strict';

const E = require('./runApi.errors');
const orchestratorErrors = require('../orchestrator/flow/flow.errors');

const INPUT_MAX = 8000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_TYPE = /^[a-z][a-z0-9_]{1,59}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Texto do pedido: string não vazia (depois de aparar) com até 8.000 caracteres; o texto vai como veio, sem aparar. */
function parseInput(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > INPUT_MAX) throw E.inputInvalid();
  return value;
}

/** `context` opcional: { entityType, entityId } vira o `subject` do run (memória e fontes do assunto). */
function parseContext(value) {
  if (value === undefined || value === null) return undefined;
  const ok = isObject(value) && typeof value.entityType === 'string' && value.entityType.trim() && value.entityType.length <= 80
    && (typeof value.entityId === 'string' || typeof value.entityId === 'number') && String(value.entityId).trim() && String(value.entityId).length <= 80;
  if (!ok) throw E.inputInvalid('Informe o contexto com entityType e entityId.');
  return { type: value.entityType.trim(), id: String(value.entityId).trim() };
}

function parseKey(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw E.inputInvalid('A chave de idempotência deve ter de 1 a 200 caracteres.');
  return value.trim();
}

function parseTaskType(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !TASK_TYPE.test(value)) throw E.inputInvalid('O tipo de tarefa é inválido.');
  return value;
}

function parseConversationId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !UUID.test(value)) throw E.inputInvalid('O identificador da conversa é inválido.');
  return value.toLowerCase();
}

const body = (raw) => (isObject(raw) ? raw : {});

/** POST /ai/runs: finalidade primeiro (sem ela nem o run nasce), depois o agente e o pedido. */
function parseRunBody(raw) {
  const b = body(raw);
  if (typeof b.purpose !== 'string' || !b.purpose.trim()) throw orchestratorErrors.purposeRequired();
  if (typeof b.agentCode !== 'string' || !b.agentCode.trim()) throw E.inputInvalid('Informe o código do agente.');
  return {
    agentCode: b.agentCode.trim(), purpose: b.purpose.trim(), input: parseInput(b.input), subject: parseContext(b.context),
    idempotencyKey: parseKey(b.idempotencyKey), taskType: parseTaskType(b.taskType), conversationId: null,
  };
}

/** POST /ai/agents/:code/chat: a finalidade é a do próprio chat (a rota a monta); o pedido vem em `message`. */
function parseChatBody(agentCode, raw, purpose) {
  const b = body(raw);
  return {
    agentCode, purpose, input: parseInput(b.message), subject: parseContext(b.context), idempotencyKey: parseKey(b.idempotencyKey),
    taskType: parseTaskType(b.taskType), conversationId: parseConversationId(b.conversationId),
  };
}

module.exports = { parseRunBody, parseChatBody, parseInput, parseKey, INPUT_MAX };
