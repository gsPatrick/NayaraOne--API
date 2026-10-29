'use strict';

/**
 * M9-D691 (3.1 passo 5 e 6, 3.4) — gravações do alert engine em analytics.alert_instances. Só o worker de BI (GUC de escrita) usa estas funções.
 * O índice único parcial (empresa, fingerprint) para OPEN/ACKNOWLEDGED é a trava final contra duas avaliações simultâneas.
 */
const { sequelize } = require('../../../models');
const { runAlert } = require('../alertErrors');

const ACTIVE = "('OPEN', 'ACKNOWLEDGED')";
const one = (rows) => rows[0] || null;

async function findActive({ companyId, fingerprint }, transaction) {
  const [rows] = await sequelize.query(
    `SELECT * FROM analytics.alert_instances WHERE company_id = :companyId AND fingerprint = :fingerprint AND status IN ${ACTIVE} FOR UPDATE`,
    { replacements: { companyId, fingerprint }, transaction }
  );
  return one(rows);
}

async function findLastResolved({ companyId, fingerprint }, transaction) {
  const [rows] = await sequelize.query(
    `SELECT * FROM analytics.alert_instances WHERE company_id = :companyId AND fingerprint = :fingerprint AND status = 'RESOLVED'
      ORDER BY resolved_at DESC LIMIT 1 FOR UPDATE`,
    { replacements: { companyId, fingerprint }, transaction }
  );
  return one(rows);
}

/** Abre a instância OPEN. Fingerprint ativo repetido (corrida): 409 ANALYTICS_ALERT_INSTANCE_ACTIVE (o chamador cai no ramo da instância existente). */
function insertOpen({ def, scope, fingerprint, metricCode, value, snapshotId, now }, transaction) {
  return runAlert(async () => {
    const [[row]] = await sequelize.query(
      `INSERT INTO analytics.alert_instances
         (alert_definition_id, company_id, group_id, fingerprint, severity, status, opened_at, last_evaluated_at, last_value, metric_snapshot_id, last_snapshot_id, metric_code)
       VALUES (:definitionId, :companyId, :groupId, :fingerprint, :severity, 'OPEN', :now, :now, :value, :snapshotId, :snapshotId, :metricCode)
       RETURNING *`,
      {
        replacements: {
          definitionId: def.id, companyId: scope.companyId, groupId: scope.groupId, fingerprint, severity: def.severity, now, value: value ?? null,
          snapshotId: snapshotId || null, metricCode,
        },
        transaction,
      }
    );
    return row;
  });
}

async function touchRepeated(id, { value, snapshotId, now }, transaction) {
  const [[row]] = await sequelize.query(
    `UPDATE analytics.alert_instances
        SET occurrence_count = occurrence_count + 1, normal_streak = 0, last_evaluated_at = :now, last_value = :value,
            metric_snapshot_id = COALESCE(:snapshotId, metric_snapshot_id), last_snapshot_id = :snapshotId, updated_at = now()
      WHERE id = :id RETURNING *`,
    { replacements: { id, value: value ?? null, snapshotId: snapshotId || null, now }, transaction }
  );
  return row;
}

async function touchNormal(id, { value, snapshotId, now }, transaction) {
  const [[row]] = await sequelize.query(
    `UPDATE analytics.alert_instances
        SET normal_streak = normal_streak + 1, last_evaluated_at = :now, last_value = COALESCE(:value, last_value), last_snapshot_id = :snapshotId, updated_at = now()
      WHERE id = :id RETURNING *`,
    { replacements: { id, value: value ?? null, snapshotId: snapshotId || null, now }, transaction }
  );
  return row;
}

/** RESOLVED. `cooldownUntil` nasce aqui (a resolução é o único ponto de partida do cooldown); nulo para encerramento por mudança da definição. */
async function resolveInstance(id, { reason, now, cooldownUntil = null, value = null, snapshotId = null }, transaction) {
  const [[row]] = await sequelize.query(
    `UPDATE analytics.alert_instances
        SET status = 'RESOLVED', resolved_at = :now, resolved_reason = :reason, cooldown_until = :cooldownUntil, last_evaluated_at = :now,
            normal_streak = normal_streak + CASE WHEN :reason = 'CONDITION_NORMALIZED' THEN 1 ELSE 0 END, last_value = COALESCE(:value, last_value),
            last_snapshot_id = COALESCE(:snapshotId, last_snapshot_id), updated_at = now()
      WHERE id = :id RETURNING *`,
    { replacements: { id, reason, now, cooldownUntil, value, snapshotId }, transaction }
  );
  return row;
}

async function suppress(id, snapshotId, transaction) {
  const [[row]] = await sequelize.query(
    'UPDATE analytics.alert_instances SET suppressed_count = suppressed_count + 1, last_snapshot_id = :snapshotId, updated_at = now() WHERE id = :id RETURNING *',
    { replacements: { id, snapshotId: snapshotId || null }, transaction }
  );
  return row;
}

/** Instâncias ativas da definição (para encerrar as do limiar antigo e para a resolução do alerta de freshness). */
async function listActiveOf(definitionId, transaction) {
  const [rows] = await sequelize.query(
    `SELECT * FROM analytics.alert_instances WHERE alert_definition_id = :definitionId AND status IN ${ACTIVE} ORDER BY opened_at FOR UPDATE`,
    { replacements: { definitionId }, transaction }
  );
  return rows;
}

module.exports = { findActive, findLastResolved, insertOpen, touchRepeated, touchNormal, resolveInstance, suppress, listActiveOf };
