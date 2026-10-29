'use strict';

/**
 * M9-D628 (3.4) — as sondas de saúde do ERP (a "/health" de src/features/health, aqui por peça): API (o processo que mede está respondendo), DATABASE (consulta
 * ao banco), QUEUE (a tabela do outbox responde) e STORAGE (o diretório de uploads aceita escrita). Cada sonda devolve verdadeiro ou falso e nunca lança; passar do
 * `timeoutMs` conta como falha. Quais sondas rodam é o parâmetro analytics.tec.sondas (padrão das quatro). O resultado de cada uma vira um sinal PROBE.
 */
const fs = require('node:fs');
const { sequelize } = require('../../../models');
const { UPLOADS_ROOT } = require('../../../utils/diskStorage');
const { KINDS, recordTechSignal } = require('./record');

const CHECKS = Object.freeze({
  API: async () => true,
  DATABASE: async () => { await sequelize.query('SELECT 1'); return true; },
  QUEUE: async () => { const [[row]] = await sequelize.query("SELECT to_regclass('integration.outbox_events') IS NOT NULL AS ok"); return row.ok === true; },
  STORAGE: async () => { await fs.promises.access(UPLOADS_ROOT, fs.constants.W_OK); return true; },
});

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

async function measure(probe, timeoutMs) {
  const check = CHECKS[probe];
  if (!check) return false;
  try { return (await withTimeout(check(), timeoutMs)) === true; } catch (_err) { return false; }
}

/** Mede e grava as sondas pedidas; devolve { PROBE: ok }. Sonda desconhecida não é gravada (não há como medir). */
async function runProbes({ probes, timeoutMs = 4000, now = new Date() }) {
  const out = {};
  for (const probe of probes.filter((p) => CHECKS[p])) {
    out[probe] = await measure(probe, timeoutMs);
    await recordTechSignal({ kind: KINDS.PROBE, probe, ok: out[probe], occurredAt: now });
  }
  return out;
}

module.exports = { PROBES: Object.freeze(Object.keys(CHECKS)), measure, runProbes };
