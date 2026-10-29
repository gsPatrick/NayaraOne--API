'use strict';

const E = require('./memory.errors');
const C = require('./memory.constants');
const { redactForStorage } = require('../security/piiRedactor');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[A-Za-z0-9_.:-]{2,64}$/;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function ctxOk(ctx) {
  if (!ctx || !ctx.groupId || !ctx.companyId) throw E.invalid('Contexto de empresa ausente.');
}

function optionalText(v, nome, max) {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return null;
  if (typeof v !== 'string') throw E.invalid(`${nome} deve ser um texto.`);
  if (v.trim().length > max) throw E.invalid(`${nome} passa de ${max} caracteres.`);
  return v.trim();
}

function oneOf(v, list, nome) {
  if (!list.includes(v)) throw E.invalid(`${nome} inválido.`, { permitidos: list });
  return v;
}

/** Entrada de save/propose/correct: normalizada; o `value` segue cru (quem o valida é memory.value). */
function parseSave(data) {
  if (!isObject(data)) throw E.invalid('Dados da memória ausentes.');
  if (!C.MEMORY_TYPES.includes(data.type)) throw E.typeInvalid(C.MEMORY_TYPES);
  if (data.sourceId === undefined || data.sourceId === null || data.sourceId === '' || !data.sourceType) throw E.sourceRequired();
  if (!isUuid(data.sourceId)) throw E.invalid('A origem informada é inválida.');
  const scope = oneOf(data.scope, C.SCOPES, 'O escopo');
  const agentCode = optionalText(data.agentCode, 'O agente', 64);
  if (agentCode && !CODE_RE.test(agentCode)) throw E.invalid('O código do agente é inválido.');
  if (scope === 'AGENT' && !agentCode) throw E.invalid('Memória de escopo AGENT precisa do código do agente.');
  const subjectType = optionalText(data.subjectType, 'O tipo do assunto', 64);
  const subjectId = optionalText(data.subjectId == null ? null : String(data.subjectId), 'O assunto', 128);
  if (subjectId && !subjectType) throw E.invalid('Informe o tipo do assunto junto com o assunto.');
  if (data.ownerUserId !== undefined && data.ownerUserId !== null && !isUuid(data.ownerUserId)) throw E.invalid('O dono informado é inválido.');
  const purpose = optionalText(data.purpose, 'A finalidade', 300);
  return {
    type: data.type,
    scope,
    agentCode,
    subjectType,
    subjectId,
    sourceType: oneOf(data.sourceType, C.SOURCE_TYPES, 'O tipo da origem'),
    sourceId: data.sourceId,
    classification: data.classification === undefined ? C.DEFAULT_CLASSIFICATION : oneOf(data.classification, C.CLASSIFICATIONS, 'A classificação'),
    purpose: purpose ? redactForStorage(purpose) : null,
    ownerUserId: data.ownerUserId || null,
    value: data.value,
    expiresAt: data.expiresAt,
    validFrom: data.validFrom,
    idempotencyKey: optionalText(data.idempotencyKey, 'A chave de idempotência', 200),
  };
}

/** Motivo da invalidação: texto de 5 a 1000 caracteres, obrigatório. */
function parseReason(data) {
  const reason = optionalText(data && data.reason, 'O motivo', 1000);
  if (!reason || reason.length < 5) throw E.invalid('Informe o motivo (mínimo de 5 caracteres).');
  return redactForStorage(reason);
}

module.exports = { ctxOk, isUuid, isObject, parseSave, parseReason };
