'use strict';

/**
 * M9-D652 / M9-D653 — instante mais recente em que os read models dados foram alimentados com dado da fonte (source_snapshot_at das linhas e dos refreshes
 * bem-sucedidos); nulo se nunca foram. Sem linha (ex.: nenhuma perda registrada) o refresh ainda conta, por isso o KPI zerado não sai "nunca atualizado".
 * O nome da tabela vem de constantes dos grupos (models.js), nunca de entrada de usuário.
 */
const { sequelize } = require('../../../../models');

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
