'use strict';

const crypto = require('node:crypto');

/** Forma única do impacto (M9-D852 §3.1): `{counts, totalAmountCents, blockers[], items[]}`; só os três primeiros entram no hash do token. */
function normalize(raw = {}) {
  const counts = {};
  // Contagem é número; um agrupamento (ex.: por tipo de cadastro) pode vir como objeto de números.
  for (const [k, v] of Object.entries(raw.counts || {})) counts[k] = v && typeof v === 'object' ? v : Number(v) || 0;
  const blockers = (raw.blockers || []).map((b) => (typeof b === 'string' ? { code: 'BLOCKED', message: b } : { code: b.code || 'BLOCKED', message: b.message }));
  return {
    counts,
    totalAmountCents: Math.round(Number(raw.totalAmountCents) || 0),
    blockers,
    items: Array.isArray(raw.items) ? raw.items : [],
  };
}

const sortKeys = (obj) => Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k] && typeof obj[k] === 'object' ? sortKeys(obj[k]) : obj[k]]));

/** Hash estável (chaves em ordem) do que o usuário viu: contagens, valor e impedimentos. */
function hash(impact) {
  const canonical = JSON.stringify({ counts: sortKeys(impact.counts), totalAmountCents: impact.totalAmountCents, blockers: impact.blockers.map((b) => `${b.code}:${b.message}`).sort() });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** "Não é possível continuar: <motivo>." (livro, mensagem de GOV_ACTION_BLOCKED). */
const blockedMessage = (impact) => `Não é possível continuar: ${impact.blockers.map((b) => b.message.replace(/[.\s]+$/, '')).join('; ')}.`;

module.exports = { normalize, hash, blockedMessage };
