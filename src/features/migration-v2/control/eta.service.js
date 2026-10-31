'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { getSetting } = require('../../settings/settings.service');
const { KEYS, INGEST_SETTING_DEFAULTS } = require('../ingest/ingest.settings');

const MIN_SECONDS = 1; // lote que durou menos que isso conta como um segundo (evita dividir por zero)

/**
 * ETA do automático (M9-D901 §3.4): vazão = média das linhas por minuto dos últimos `migracao.eta.janela_lotes` lotes APPLIED ou VERIFIED (replays não contam: releem o que já
 * foi aplicado); ETA_min = ceil(not_started / vazão). Sem lote, ou vazão zero, eta_min é null com o motivo (NO_BATCHES ou ZERO_THROUGHPUT). Quarentena e revisão dependem de
 * pessoas e ficam de fora do cálculo.
 */
async function computeEta(tenant, scope, notStarted, transaction) {
  const windowSize = Math.max(1, Number(await getSetting(KEYS.ETA_WINDOW, tenant, transaction, INGEST_SETTING_DEFAULTS[KEYS.ETA_WINDOW])) || 1);
  const rows = await sequelize.query(
    `SELECT row_count, GREATEST(EXTRACT(EPOCH FROM (finished_at - started_at)), :minSeconds) AS seconds FROM governance.mig_batches
      WHERE company_id = :companyId AND status IN ('APPLIED', 'VERIFIED') AND replay_of IS NULL AND started_at IS NOT NULL AND finished_at IS NOT NULL
        AND (:system::text IS NULL OR source_system = :system) AND (:entity::text IS NULL OR entity = :entity) ORDER BY finished_at DESC, id DESC LIMIT :limit`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, system: scope.sourceSystem || null, entity: scope.entity || null, limit: windowSize, minSeconds: MIN_SECONDS } }
  );
  const rates = rows.map((row) => Number(row.row_count) / (Number(row.seconds) / 60));
  const throughput = rates.length ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 100) / 100 : 0;
  const base = { window: windowSize, batches: rows.length, throughput_rows_per_min: throughput };
  if (!rows.length) return { ...base, eta_min: null, reason: 'NO_BATCHES' };
  if (throughput <= 0) return { ...base, eta_min: null, reason: 'ZERO_THROUGHPUT' };
  return { ...base, eta_min: notStarted > 0 ? Math.ceil(notStarted / throughput) : 0, reason: null };
}

module.exports = { computeEta };
