'use strict';

/** Formato das respostas administrativas das integrações (M9-D249 3.2): datas ISO-8601 com fuso -03:00 e referência de cofre mascarada. */
const OFFSET_MS = 3 * 60 * 60 * 1000;
const SECRET_TAIL = 4;

function toBrt(value) {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() - OFFSET_MS).toISOString().replace('Z', '-03:00');
}

/** Copia o valor trocando cada Date pelo texto com fuso -03:00. Texto, número e JSON de terceiros passam como estão. */
function brtDeep(value) {
  if (value instanceof Date) return toBrt(value);
  if (Array.isArray(value)) return value.map(brtDeep);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, brtDeep(v)]));
  }
  return value;
}

/** Referência do cofre: só os últimos 4 caracteres, precedidos de reticências. Nunca o caminho completo. */
function maskSecretRef(ref) {
  if (ref === null || ref === undefined || ref === '') return null;
  return `…${String(ref).slice(-SECRET_TAIL)}`;
}

/** Dias inteiros até o vencimento do segredo (negativo se já venceu); null sem vencimento. */
function daysUntil(date, now = new Date()) {
  if (!date) return null;
  return Math.ceil((new Date(date).getTime() - now.getTime()) / 86400000);
}

module.exports = { toBrt, brtDeep, maskSecretRef, daysUntil };
