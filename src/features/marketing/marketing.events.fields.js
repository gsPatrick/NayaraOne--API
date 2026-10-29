'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:\-/ ]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/i;
const AMOUNT_TEXT = /^-?\d+(\.\d{1,6})?$/;

const isInt = (v) => Number.isInteger(v) && v >= 1;
const isIso = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
const isCode = (v) => typeof v === 'string' && CODE.test(v);
const isAmount = (v) => v === null || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && AMOUNT_TEXT.test(v));

/** Referência a uma entidade: código curto ou {type, id}. */
function isRef(v) {
  if (isCode(v)) return true;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => k === 'type' || k === 'id') && keys.every((k) => isCode(v[k]) || (k === 'id' && UUID.test(v[k])));
}

/** Resumo de ações: objeto plano de contadores/códigos curtos (até 32 chaves). */
function isSummary(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const entries = Object.entries(v);
  return entries.length <= 32 && entries.every(([k, x]) => CODE.test(k) && (Number.isFinite(x) || isCode(x)));
}

/** Validadores de tipo de campo; cada um recebe o valor e devolve boolean. */
const CHECKS = Object.freeze({
  uuid: (v) => typeof v === 'string' && UUID.test(v),
  nullableUuid: (v) => v === null || (typeof v === 'string' && UUID.test(v)), // M9-D409: rascunho de sistema (gatilho) não tem pessoa autora
  int: isInt,
  code: isCode,
  nullableCode: (v) => v === null || isCode(v),
  nullableUrl: (v) => v === null || (typeof v === 'string' && /^https?:\/\/[^\s]+$/i.test(v)),
  boolean: (v) => typeof v === 'boolean',
  iso: isIso,
  amount: isAmount,
  ref: isRef,
  summary: isSummary,
  hash: (v) => typeof v === 'string' && HASH.test(v),
});

module.exports = { CHECKS, UUID };
