'use strict';

/**
 * M9-D413 — Validade da versão: fora de [valid_from, valid_until] a versão NÃO dispara. O runner (M9-D414, passo 2) chama esta função
 * e, se `ok` for falso, cria a run BLOCKED com `OUTSIDE_VALIDITY`. Início inclusivo; fim inclusivo; limite ausente = sem limite.
 */
function evaluateValidity(version, now = new Date()) {
  const from = version.valid_from || version.validFrom;
  const until = version.valid_until || version.validUntil;
  const t = now.getTime();
  if (from && t < new Date(from).getTime()) return { ok: false, reason: 'OUTSIDE_VALIDITY' };
  if (until && t > new Date(until).getTime()) return { ok: false, reason: 'OUTSIDE_VALIDITY' };
  return { ok: true };
}

module.exports = { evaluateValidity };
