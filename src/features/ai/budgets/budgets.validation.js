'use strict';

const E = require('./budgets.errors');
const { MODEL_CLASSES, STATUSES, ACTIONS_AT_100 } = require('./budgets.constants');
const { parseThresholds } = require('./budgets.settings');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT = /^[A-Z0-9_]{2,80}$/;
const LIMIT = /^\d{1,16}(?:\.\d{1,2})?$/;

const isUuid = (v) => typeof v === 'string' && UUID.test(v);

function parseLimit(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !LIMIT.test(text.trim()) || Number(text) <= 0) {
    throw E.invalid('O limite deve ser um valor em reais maior que zero, com até duas casas.', { field: 'limitAmount' });
  }
  return text.trim();
}

function parseThresholdField(value) {
  if (value === null) return null;
  const list = parseThresholds(value);
  if (!list) throw E.invalid('Os limiares devem ser de 1 a 10 porcentagens inteiras crescentes (ex.: 50,75,90,100).', { field: 'thresholds' });
  return list;
}

function parseAction(value) {
  if (value === null) return null;
  if (!ACTIONS_AT_100.includes(value)) throw E.invalid('A ação ao chegar em 100% deve ser BLOCK ou DEGRADE.', { field: 'actionAt100' });
  return value;
}

function plainBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw E.invalid('Corpo da requisição inválido.');
  return body;
}

/** Criação: agentCode e modelClass opcionais (ausente = todos); limitAmount obrigatório. */
function parseCreate(raw) {
  const b = plainBody(raw);
  const out = { limitAmount: parseLimit(b.limitAmount), agentCode: null, modelClass: null, thresholds: null, actionAt100: null };
  if (b.agentCode !== undefined && b.agentCode !== null) {
    const code = typeof b.agentCode === 'string' ? b.agentCode.trim().toUpperCase() : '';
    if (!AGENT.test(code)) throw E.invalid('Código de agente inválido.', { field: 'agentCode' });
    out.agentCode = code;
  }
  if (b.modelClass !== undefined && b.modelClass !== null) {
    if (!MODEL_CLASSES.includes(b.modelClass)) throw E.invalid('A classe do modelo deve ser SMALL, ADVANCED ou EMBEDDING.', { field: 'modelClass' });
    out.modelClass = b.modelClass;
  }
  if (b.thresholds !== undefined) out.thresholds = parseThresholdField(b.thresholds);
  if (b.actionAt100 !== undefined) out.actionAt100 = parseAction(b.actionAt100);
  return out;
}

/** Edição: só os campos enviados mudam; thresholds/actionAt100 nulos voltam a seguir os parâmetros da empresa. */
function parseUpdate(raw) {
  const b = plainBody(raw);
  const out = {};
  if (b.limitAmount !== undefined) out.limitAmount = parseLimit(b.limitAmount);
  if (b.thresholds !== undefined) out.thresholds = parseThresholdField(b.thresholds);
  if (b.actionAt100 !== undefined) out.actionAt100 = parseAction(b.actionAt100);
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) throw E.invalid('O status deve ser ACTIVE ou PAUSED.', { field: 'status' });
    out.status = b.status;
  }
  if (!Object.keys(out).length) throw E.invalid('Informe ao menos um campo para alterar.');
  return out;
}

module.exports = { isUuid, parseCreate, parseUpdate };
