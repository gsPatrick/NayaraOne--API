'use strict';

/**
 * M9-D660 / M9-D661 — instante mais recente em que os read models do Jurídico e do Correspondente foram alimentados com dado da fonte
 * (source_snapshot_at das linhas e dos refreshes bem-sucedidos); nulo se nunca foram. Só lê o schema analytics. As tabelas vêm de constantes
 * (a varredura de segurança M9-D700 só deixa citar o nome do read model na camada read-models e nas definições).
 */
const { sequelize } = require('../../../../../models');

async function latestSnapshotAt(companyId, models, transaction) {
  const parts = models.map((m) => `SELECT max(source_snapshot_at) AS at FROM analytics.${m} WHERE company_id = :companyId`).join(' UNION ALL ');
  const [rows] = await sequelize.query(`SELECT max(at) AS at FROM (${parts}) x`, { replacements: { companyId }, transaction });
  const [refreshed] = await sequelize.query(
    "SELECT max(source_snapshot_at) AS at FROM analytics.read_model_refreshes WHERE company_id = :companyId AND read_model IN (:models) AND status IN ('SUCCEEDED', 'DEGRADED')",
    { replacements: { companyId, models }, transaction }
  );
  const times = [rows[0] && rows[0].at, refreshed[0] && refreshed[0].at].filter(Boolean).map((v) => new Date(v));
  return times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null;
}

module.exports = { latestSnapshotAt };
