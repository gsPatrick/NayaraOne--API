'use strict';

/**
 * M9-D602 — definições de alerta (analytics.alert_definitions).
 *
 * Regras do livro: condição exclusiva (limite simples OU regra publicada do Motor de Regras), owner
 * obrigatório (BI-011), cooldown nulo = padrão da severidade (lido pelo motor, M9-D691), nenhuma ação de
 * pagamento. O motor de avaliação é da M9-D691; severidade/tarefa da M9-D692. Escrita só com a GUC do worker
 * ou da rota administrativa (`analytics:alert:manage`), com auditoria antes/depois.
 */

const { sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { resolveScope, assertWriter } = require('./analyticsStoreSupport');
const { runAlert } = require('./alertErrors');
const { validateAlertDefinition } = require('./alertDefinitionRules');

const notFound = () => AppError.notFound('Definição de alerta não encontrada.', 'ANALYTICS_ALERT_NOT_FOUND');
const SCOPE_CODE = 'ANALYTICS_ALERT_INVALID';

async function audit(ctx, action, row, before, transaction) {
  await registrarAuditoria(
    {
      groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.actorUserId, action, entityType: 'analytics.alert_definition',
      entityId: row.id, beforeJson: before,
      afterJson: { alertCode: row.alert_code, metricCode: row.metric_code, conditionType: row.condition_type, severity: row.severity, status: row.status, version: row.version },
      reason: `Definição de alerta ${row.alert_code} (versão ${row.version})`,
    },
    transaction
  );
}

/** Cria a definição em DRAFT (versão 1). 422 com o código do livro para owner, condição, regra e pagamento. */
async function createAlertDefinition(input, ctx, transaction) {
  await assertWriter(transaction);
  validateAlertDefinition(input);
  const scope = resolveScope(input, SCOPE_CODE);
  return runAlert(async () => {
    const [[row]] = await sequelize.query(
      `INSERT INTO analytics.alert_definitions
         (company_id, group_id, alert_code, metric_code, metric_version_pin, condition_type, threshold, rule_id, severity, owner_user_id,
          owner_role, cooldown_minutes, auto_resolve_policy, scope, create_task, created_by, updated_by)
       VALUES (:companyId, :groupId, :alertCode, :metricCode, :pin, :conditionType, CAST(:threshold AS jsonb), :ruleId, :severity, :ownerUserId,
          :ownerRole, :cooldown, CAST(:autoResolve AS jsonb), CAST(:scope AS jsonb), :createTask, :actor, :actor)
       RETURNING *`,
      {
        replacements: {
          ...scope, alertCode: input.alertCode, metricCode: input.metricCode, pin: input.metricVersionPin ?? null,
          conditionType: input.conditionType, threshold: input.threshold == null ? null : JSON.stringify(input.threshold),
          ruleId: input.ruleId || null, severity: input.severity, ownerUserId: input.ownerUserId || null,
          ownerRole: input.ownerRole ? input.ownerRole.trim() : null, cooldown: input.cooldownMinutes ?? null,
          autoResolve: JSON.stringify(input.autoResolvePolicy || {}), scope: JSON.stringify(input.scope || {}),
          createTask: input.createTask === true, actor: ctx?.actorUserId || null,
        },
        transaction,
      }
    );
    await audit(ctx, 'analytics.alert.create', row, null, transaction);
    return row;
  });
}

async function setStatus(id, from, to, action, ctx, transaction) {
  await assertWriter(transaction);
  return runAlert(async () => {
    const [rows] = await sequelize.query('SELECT * FROM analytics.alert_definitions WHERE id = :id FOR UPDATE', { replacements: { id }, transaction });
    const current = rows[0];
    if (!current) throw notFound();
    if (!from.includes(current.status)) {
      throw AppError.conflict(`A definição está ${current.status} e não pode ir para ${to}.`, 'ANALYTICS_ALERT_DEFINITION_STATE');
    }
    const [[row]] = await sequelize.query(
      `UPDATE analytics.alert_definitions
          SET status = :to, published_at = CASE WHEN :to = 'PUBLISHED' THEN now() ELSE published_at END, updated_by = :actor, updated_at = now()
        WHERE id = :id RETURNING *`,
      { replacements: { id, to, actor: ctx?.actorUserId || null }, transaction }
    );
    await audit(ctx, action, row, { status: current.status }, transaction);
    return row;
  });
}

const publishAlertDefinition = (id, ctx, transaction) => setStatus(id, ['DRAFT', 'DISABLED'], 'PUBLISHED', 'analytics.alert.publish', ctx, transaction);
const disableAlertDefinition = (id, ctx, transaction) => setStatus(id, ['PUBLISHED'], 'DISABLED', 'analytics.alert.disable', ctx, transaction);

/** Definições PUBLISHED visíveis ao contexto (RLS): é o que o alert engine (M9-D691) carrega. */
async function listPublishedAlertDefinitions(ctx, transaction, { metricCode = null } = {}) {
  const [rows] = await sequelize.query(
    `SELECT * FROM analytics.alert_definitions WHERE status = 'PUBLISHED' AND (CAST(:metricCode AS text) IS NULL OR metric_code = :metricCode)
      ORDER BY alert_code, version`,
    { replacements: { metricCode }, transaction }
  );
  return rows;
}

module.exports = { createAlertDefinition, publishAlertDefinition, disableAlertDefinition, listPublishedAlertDefinitions };
