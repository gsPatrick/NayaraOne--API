'use strict';

/**
 * Corpo `confirmation` do POST/DELETE da ação (M9-D852 §3.1): `{understood?, typedCode?, justification?, impactToken}`.
 * Nível 1: nada a conferir. Nível 2: `understood === true` e `impactToken`. Nível 3: `typedCode` igual ao código do registro,
 * `justification` com o mínimo do parâmetro e `impactToken`. Devolve a lista dos campos que faltam ou não conferem.
 */
const text = (v) => (typeof v === 'string' ? v.trim() : '');

function check({ level, body, expectedCode, justificationMin }) {
  if (level <= 1) return [];
  const c = body && typeof body.confirmation === 'object' && body.confirmation ? body.confirmation : {};
  const missing = [];
  if (level === 2 && c.understood !== true) missing.push('understood');
  if (level >= 3) {
    if (!text(c.typedCode) || text(c.typedCode) !== String(expectedCode || '').trim()) missing.push('typedCode');
    if (text(c.justification).length < justificationMin) missing.push('justification');
  }
  if (!text(c.impactToken)) missing.push('impactToken');
  return missing;
}

const confirmationOf = (body) => (body && typeof body.confirmation === 'object' && body.confirmation ? body.confirmation : {});

module.exports = { check, confirmationOf, text };
