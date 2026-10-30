'use strict';

const {
  TRIGGER_TYPES, RISK_LEVELS, COOLDOWN_UNITS, FREQUENCY_SCOPES, MAX_ACTIONS, ACTION_TYPES, TRIGGER_EVENTS,
} = require('./catalog');
const { incomplete, actionUnknown, invalidBody } = require('./definition.errors');
const { CAP_PARAM_KEYS } = require('./leadParams');

const BODY_FIELDS = [
  'flowId', 'code', 'name', 'ownerUserId', 'riskLevel', 'triggerType', 'triggerConfig', 'conditions', 'conditionsEmptyReason',
  'actions', 'cooldown', 'frequencyCap', 'validFrom', 'validUntil',
];
const DEFINITION_FIELDS = BODY_FIELDS.filter((f) => !['flowId', 'code', 'name'].includes(f));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;
const RULE_CODE = /^[A-Za-z0-9_.:-]{1,120}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const positiveInt = (v) => Number.isInteger(v) && v >= 1;

/** Corpo de POST /marketing/automations: só os campos conhecidos (campo desconhecido é 400 MKT_VALIDATION). */
function parseBody(body) {
  if (!isObject(body)) throw invalidBody('Corpo da requisição inválido.');
  const unknown = Object.keys(body).filter((k) => !BODY_FIELDS.includes(k));
  if (unknown.length > 0) throw invalidBody(`Dados inválidos: campo(s) desconhecido(s): ${unknown.join(', ')}.`, { unknown });
  if (body.flowId !== undefined && !isUuid(body.flowId)) throw invalidBody('Dados inválidos: flowId.', { field: 'flowId' });
  for (const f of ['code', 'name']) {
    if (body[f] !== undefined && (typeof body[f] !== 'string' || !body[f].trim() || body[f].length > 200)) throw invalidBody(`Dados inválidos: ${f}.`, { field: f });
  }
  return body;
}

function validCron(text) {
  const parts = typeof text === 'string' ? text.trim().split(/\s+/) : [];
  return parts.length === 5 && parts.every((p) => CRON_FIELD.test(p)); // 5 campos = granularidade mínima de 1 minuto
}

function validTimeZone(zone) {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: zone });
    return typeof zone === 'string' && zone.length > 0;
  } catch (err) {
    return false;
  }
}

function checkTrigger(def, problems) {
  if (!TRIGGER_TYPES.includes(def.triggerType)) { problems.push({ field: 'triggerType', reason: `Use um de: ${TRIGGER_TYPES.join(', ')}.` }); return; }
  const cfg = def.triggerConfig;
  if (!isObject(cfg)) { problems.push({ field: 'triggerConfig', reason: 'Informe a configuração do gatilho.' }); return; }
  if (def.triggerType === 'EVENT') {
    if (!TRIGGER_EVENTS.includes(cfg.eventType)) problems.push({ field: 'triggerConfig.eventType', reason: 'Evento fora do catálogo de gatilhos.' });
  } else {
    if (!validCron(cfg.cron)) problems.push({ field: 'triggerConfig.cron', reason: 'Informe a expressão cron de 5 campos (mínimo de 1 minuto).' });
    if (!validTimeZone(cfg.timeZone)) problems.push({ field: 'triggerConfig.timeZone', reason: 'Informe o fuso horário.' });
  }
}

function checkConditions(def, problems) {
  if (!Array.isArray(def.conditions)) { problems.push({ field: 'conditions', reason: 'Informe a lista de regras (pode ser vazia com justificativa).' }); return; }
  if (!def.conditions.every((c) => typeof c === 'string' && RULE_CODE.test(c))) problems.push({ field: 'conditions', reason: 'Cada condição é o código de uma regra do Motor de Regras.' });
  const reason = typeof def.conditionsEmptyReason === 'string' ? def.conditionsEmptyReason.trim() : '';
  if (def.conditions.length === 0 && !reason) problems.push({ field: 'conditionsEmptyReason', reason: 'Sem condições, informe a justificativa.' });
}

function checkActions(def, problems) {
  if (!Array.isArray(def.actions) || def.actions.length < 1 || def.actions.length > MAX_ACTIONS) {
    problems.push({ field: 'actions', reason: `Informe de 1 a ${MAX_ACTIONS} ações.` });
    return;
  }
  def.actions.forEach((action, i) => {
    if (!isObject(action) || typeof action.actionType !== 'string' || !action.actionType) problems.push({ field: `actions[${i}].actionType`, reason: 'Informe o tipo da ação.' });
  });
}

function checkLimits(def, problems) {
  const c = def.cooldown;
  if (!isObject(c) || !positiveInt(c.amount) || !COOLDOWN_UNITS.includes(c.unit)) problems.push({ field: 'cooldown', reason: `Informe {amount inteiro >= 1, unit: ${COOLDOWN_UNITS.join('|')}}.` });
  const f = def.frequencyCap;
  // max e windowDays são números ou o nome de um parâmetro da lista fechada (maxParam, windowDaysParam), lido na hora da avaliação (M9-D420)
  const part = (value, param) => (param === undefined ? positiveInt(value) : value === undefined && CAP_PARAM_KEYS.includes(param));
  if (!isObject(f) || !part(f.max, f.maxParam) || !part(f.windowDays, f.windowDaysParam) || !FREQUENCY_SCOPES.includes(f.scope)) {
    problems.push({ field: 'frequencyCap', reason: `Informe {max >= 1, windowDays >= 1, scope: ${FREQUENCY_SCOPES.join('|')}}.` });
  }
}

function checkValidity(def, problems) {
  const from = def.validFrom ? new Date(def.validFrom) : null;
  const until = def.validUntil ? new Date(def.validUntil) : null;
  if (def.validFrom && Number.isNaN(from.getTime())) problems.push({ field: 'validFrom', reason: 'Data inválida.' });
  if (def.validUntil && Number.isNaN(until.getTime())) problems.push({ field: 'validUntil', reason: 'Data inválida.' });
  if (from && until && !(until > from)) problems.push({ field: 'validUntil', reason: 'O fim da validade deve ser depois do início.' });
}

/**
 * Confere a definição COMPLETA (criação do rascunho e publicação). Devolve a lista de itens que faltam (field + reason);
 * ação fora do catálogo é erro à parte (422 MKT_AUTOMATION_ACTION_UNKNOWN). O dono (owner) é conferido pelo serviço (precisa do banco).
 */
function collectProblems(def) {
  const problems = [];
  checkTrigger(def, problems);
  checkConditions(def, problems);
  checkActions(def, problems);
  checkLimits(def, problems);
  checkValidity(def, problems);
  if (!RISK_LEVELS.includes(def.riskLevel)) problems.push({ field: 'riskLevel', reason: `Use um de: ${RISK_LEVELS.join(', ')}.` });
  return problems;
}

function assertKnownActions(def) {
  const unknown = (Array.isArray(def.actions) ? def.actions : []).map((a) => a && a.actionType).filter((t) => typeof t === 'string' && t && !ACTION_TYPES.includes(t));
  if (unknown.length > 0) throw actionUnknown({ actionTypes: [...new Set(unknown)], allowed: ACTION_TYPES });
}

function assertComplete(def, extraProblems = []) {
  assertKnownActions(def);
  const problems = [...collectProblems(def), ...extraProblems];
  if (problems.length > 0) throw incomplete(problems);
}

/** Pega do corpo só os campos da versão (sem flowId/code/name). */
function pickDefinition(source) {
  const out = {};
  for (const f of DEFINITION_FIELDS) if (source[f] !== undefined) out[f] = source[f];
  return out;
}

module.exports = { parseBody, collectProblems, assertComplete, assertKnownActions, pickDefinition, isUuid, DEFINITION_FIELDS };
