'use strict';

const fs = require('node:fs');
const { REQUIRED_FIELDS, DAY_MS, EXCEPTIONS_FILE } = require('./depaudit.constants');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = (iso) => Date.parse(`${iso}T00:00:00Z`);

/** Lê o arquivo de exceções; ausente = lista vazia; JSON quebrado ou sem a lista é erro (nunca "sem exceções" por engano). */
function loadExceptions(file = EXCEPTIONS_FILE) {
  if (!fs.existsSync(file)) return [];
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!doc || !Array.isArray(doc.exceptions)) throw new Error(`${file}: o arquivo precisa ter a lista "exceptions".`);
  return doc.exceptions;
}

/**
 * Situação de uma exceção na data `now`: VALID, EXPIRED (passou de expiresAt) ou INVALID (campo faltando, data ruim, validade
 * acima de `maxDays` dias entre grantedAt e expiresAt, ou concedida no futuro). Só VALID livra o aviso.
 */
function exceptionState(e, { now = new Date(), maxDays = 30 } = {}) {
  const faltando = REQUIRED_FIELDS.filter((f) => typeof e?.[f] !== 'string' || !e[f].trim());
  if (faltando.length) return { state: 'INVALID', reason: `faltam campos: ${faltando.join(', ')}` };
  if (!DATE_RE.test(e.grantedAt) || !DATE_RE.test(e.expiresAt) || Number.isNaN(dayMs(e.grantedAt)) || Number.isNaN(dayMs(e.expiresAt))) {
    return { state: 'INVALID', reason: 'datas devem ser AAAA-MM-DD' };
  }
  const dias = (dayMs(e.expiresAt) - dayMs(e.grantedAt)) / DAY_MS;
  if (dias < 0) return { state: 'INVALID', reason: 'expiresAt antes de grantedAt' };
  if (dias > maxDays) return { state: 'INVALID', reason: `validade de ${dias} dias passa do máximo de ${maxDays}` };
  const hoje = dayMs(new Date(now).toISOString().slice(0, 10));
  if (dayMs(e.grantedAt) > hoje) return { state: 'INVALID', reason: 'concedida em data futura' };
  if (hoje > dayMs(e.expiresAt)) return { state: 'EXPIRED', reason: `venceu em ${e.expiresAt}` };
  return { state: 'VALID', reason: null };
}

module.exports = { loadExceptions, exceptionState };
