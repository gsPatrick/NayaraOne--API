'use strict';

/**
 * M9-D602 — instâncias de alerta (analytics.alert_instances): OPEN, ACKNOWLEDGED, RESOLVED.
 *
 * - Abrir, repetir avaliação e resolver são do worker de BI (GUC de escrita). O motor de avaliação, o
 *   cooldown e o cálculo do fingerprint são da M9-D691; severidade/tarefa da M9-D692.
 * - Reconhecer roda na transação da requisição do usuário, SEM a GUC do worker (exceção prevista na D600):
 *   a RLS e o gatilho só deixam OPEN -> ACKNOWLEDGED em nome do próprio usuário. A rota e a auditoria final são da M9-D703.
 * - O índice único parcial (empresa, fingerprint) para OPEN/ACKNOWLEDGED é a trava final contra duplicata.
 */

const { sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { invalid, assertWriter } = require('./analyticsStoreSupport');
const { runAlert } = require('./alertErrors');
const { SEVERITIES } = require('./alertDefinitionRules');

const CODE = 'ANALYTICS_ALERT_INSTANCE_INVALID';
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const notFound = () => AppError.notFound('Alerta não encontrado.', 'ANALYTICS_ALERT_INSTANCE_NOT_FOUND');
const finalError = () => AppError.conflict('O alerta já foi resolvido.', 'ANALYTICS_ALERT_INSTANCE_FINAL');

async function loadInstance(id, transaction) {
  const [rows] = await sequelize.query('SELECT * FROM analytics.alert_instances WHERE id = :id FOR UPDATE', { replacements: { id }, transaction });
  if (!rows[0]) throw notFound();
  return rows[0];
}

async function assertSnapshotExists(snapshotId, transaction) {
  const [rows] = await sequelize.query('SELECT 1 FROM analytics.metric_snapshots WHERE id = :id', { replacements: { id: snapshotId }, transaction });
  if (!rows.length) throw AppError.notFound('Snapshot da métrica não encontrado.', 'ANALYTICS_SNAPSHOT_NOT_FOUND');
}

/** Abre uma instância OPEN. Fingerprint ativo repetido: 409 ANALYTICS_ALERT_INSTANCE_ACTIVE. */
async function openAlertInstance(input, ctx, transaction) {
  await assertWriter(transaction);
  if (!FINGERPRINT_RE.test(String(input.fingerprint || ''))) throw invalid(CODE, 'O fingerprint deve ser um SHA-256 em hexadecimal (64 caracteres).');
  if (!SEVERITIES.includes(input.severity)) throw invalid(CODE, `Severidade inválida. Valores aceitos: ${SEVERITIES.join(', ')}.`);
  if (!input.alertDefinitionId || !input.companyId || !input.groupId) throw invalid(CODE, 'Informe a definição, a empresa e o grupo.');
  return runAlert(async () => {
    if (input.metricSnapshotId) await assertSnapshotExists(input.metricSnapshotId, transaction);
    const [[row]] = await sequelize.query(
      `INSERT INTO analytics.alert_instances
         (alert_definition_id, company_id, group_id, fingerprint, severity, last_value, metric_snapshot_id, task_id, cooldown_until)
       VALUES (:definitionId, :companyId, :groupId, :fingerprint, :severity, :lastValue, :snapshotId, :taskId, :cooldownUntil)
       RETURNING *`,
      {
        replacements: {
          definitionId: input.alertDefinitionId, companyId: input.companyId, groupId: input.groupId, fingerprint: input.fingerprint,
          severity: input.severity, lastValue: input.lastValue ?? null, snapshotId: input.metricSnapshotId || null,
          taskId: input.taskId || null, cooldownUntil: input.cooldownUntil || null,
        },
        transaction,
      }
    );
    return row;
  });
}

/** Mais uma avaliação que repetiu a condição: soma a ocorrência e atualiza último valor e instante. */
async function recordRepeatedEvaluation(id, { lastValue = null, metricSnapshotId = null, cooldownUntil = null } = {}, ctx, transaction) {
  await assertWriter(transaction);
  return runAlert(async () => {
    const current = await loadInstance(id, transaction);
    if (current.status === 'RESOLVED') throw finalError();
    if (metricSnapshotId) await assertSnapshotExists(metricSnapshotId, transaction);
    const [[row]] = await sequelize.query(
      `UPDATE analytics.alert_instances
          SET occurrence_count = occurrence_count + 1, last_evaluated_at = now(), last_value = :lastValue,
              metric_snapshot_id = COALESCE(:snapshotId, metric_snapshot_id), cooldown_until = COALESCE(:cooldownUntil, cooldown_until), updated_at = now()
        WHERE id = :id RETURNING *`,
      { replacements: { id, lastValue, snapshotId: metricSnapshotId, cooldownUntil }, transaction }
    );
    return row;
  });
}

/** Reconhece o alerta em nome do usuário do contexto. Sem a GUC do worker: roda na transação da requisição. */
async function acknowledgeAlertInstance(id, ctx, transaction) {
  if (!ctx?.actorUserId) throw invalid(CODE, 'Informe quem está reconhecendo o alerta.');
  return runAlert(async () => {
    const current = await loadInstance(id, transaction);
    if (current.status === 'RESOLVED') throw finalError();
    if (current.status === 'ACKNOWLEDGED') return current;
    const [[row]] = await sequelize.query(
      `UPDATE analytics.alert_instances SET status = 'ACKNOWLEDGED', acknowledged_at = now(), acknowledged_by = :actor, updated_at = now()
        WHERE id = :id RETURNING *`,
      { replacements: { id, actor: ctx.actorUserId }, transaction }
    );
    return row;
  });
}

/** Resolve porque a condição normalizou (única razão do livro). Estado final. */
async function resolveAlertInstance(id, ctx, transaction) {
  await assertWriter(transaction);
  return runAlert(async () => {
    const current = await loadInstance(id, transaction);
    if (current.status === 'RESOLVED') throw finalError();
    const [[row]] = await sequelize.query(
      `UPDATE analytics.alert_instances SET status = 'RESOLVED', resolved_at = now(), resolved_reason = 'CONDITION_NORMALIZED', updated_at = now()
        WHERE id = :id RETURNING *`,
      { replacements: { id }, transaction }
    );
    return row;
  });
}

module.exports = { openAlertInstance, recordRepeatedEvaluation, acknowledgeAlertInstance, resolveAlertInstance };
