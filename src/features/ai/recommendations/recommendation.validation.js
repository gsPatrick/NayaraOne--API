'use strict';

const crypto = require('node:crypto');
const E = require('./recommendation.errors');
const C = require('./recommendation.constants');
const { redactText } = require('../../../shared/redaction');
const { sanitizeToolCalls } = require('../audit');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function ctxOk(ctx) {
  if (!ctx || !ctx.groupId || !ctx.companyId) throw E.invalid('Contexto de empresa ausente.');
}

function text(value, nome, max, { required = false } = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    if (required) throw E.invalid(`${nome} é obrigatório.`);
    return null;
  }
  if (typeof value !== 'string') throw E.invalid(`${nome} deve ser um texto.`);
  return redactText(value.trim()).slice(0, max);
}

function uuid(value, nome, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw E.invalid(`${nome} é obrigatório.`);
    return null;
  }
  if (!isUuid(value)) throw E.invalid(`${nome} inválido.`);
  return value;
}

function proposedAction(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || typeof value.tool !== 'string' || !value.tool.trim()) throw E.invalid('A ação proposta precisa informar a ferramenta (tool).');
  const out = sanitizeToolCalls(value);
  if (value.snapshot_hash !== undefined && !/^[0-9a-f]{64}$/.test(String(value.snapshot_hash))) throw E.invalid('snapshot_hash deve ser um hash de 64 caracteres.');
  return out;
}

/** Entrada de createRecommendation: normalizada, com texto redigido e cortado nos limites; `rationaleMax` vem do parâmetro. */
function parseCreate(data = {}, { rationaleMax }) {
  if (!isObject(data)) throw E.invalid('Dados da recomendação ausentes.');
  const riskLevel = data.riskLevel === undefined ? 'LOW' : data.riskLevel;
  if (!C.RISK_LEVELS.includes(riskLevel)) throw E.invalid('Nível de risco inválido.', { permitidos: C.RISK_LEVELS });
  let confidence = null;
  if (data.confidence !== undefined && data.confidence !== null) {
    confidence = Number(data.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw E.invalid('A confiança deve estar entre 0 e 1.');
  }
  if (data.payload !== undefined && data.payload !== null && !isObject(data.payload)) throw E.invalid('O payload deve ser um objeto.');
  return {
    agentCode: text(data.agentCode, 'O agente', 64, { required: true }),
    aiRunId: uuid(data.aiRunId, 'A execução'),
    relatedEntityType: text(data.relatedEntityType, 'O tipo da entidade', 64, { required: true }),
    relatedEntityId: uuid(data.relatedEntityId, 'A entidade', { required: true }),
    recommendationType: text(data.recommendationType, 'O tipo da recomendação', 64, { required: true }),
    title: text(data.title, 'O título', 200, { required: true }),
    rationale: text(data.rationale, 'A justificativa', rationaleMax),
    confidence,
    riskLevel,
    proposedAction: proposedAction(data.proposedAction),
    payload: data.payload ? sanitizeToolCalls(data.payload) : null,
    targetUserId: uuid(data.targetUserId, 'O destinatário'),
  };
}

/** Motivo da decisão (obrigatório ao rejeitar quando o parâmetro estiver ligado). */
function parseReason(data, { required }) {
  const reason = text(data && data.reason, 'O motivo', 1000, { required });
  return reason;
}

/** Chave de duplicidade: agente + entidade + tipo + dia (UTC). Mesma sugestão pendente no mesmo dia não se repete. */
function dedupKey(d, now = new Date()) {
  const dia = now.toISOString().slice(0, 10);
  return crypto.createHash('sha256').update([d.agentCode, d.relatedEntityType, d.relatedEntityId, d.recommendationType, dia].join('|')).digest('hex');
}

module.exports = { ctxOk, isUuid, isObject, parseCreate, parseReason, dedupKey, text };
