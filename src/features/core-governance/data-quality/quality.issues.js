'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { publishGovernanceEvent } = require('../governance.events');
const { EVENT_ISSUE_OPENED, ISSUE_STATUS } = require('./quality.constants');
const { stewardOfEntity } = require('./quality.steward');
const { handleIssueOpened } = require('./quality.review');

const AUDIT_ENTITY = 'QualityIssue';

const lockOpen = (tenant, entityType, entityId, transaction) => sequelize.query(
  "SELECT * FROM governance.quality_issues WHERE company_id = :companyId AND entity_type = :entityType AND entity_id = :entityId AND status = 'OPEN' FOR UPDATE",
  { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, entityType, entityId } }
);

async function insertIssue(tenant, entityType, entityId, rule, stewardId, transaction) {
  const rows = await sequelize.query(
    `INSERT INTO governance.quality_issues (group_id, company_id, entity_type, entity_id, rule_code, severity, status, assigned_steward_id)
     VALUES (:groupId, :companyId, :entityType, :entityId, :ruleCode, :severity, 'OPEN', :stewardId)
     ON CONFLICT (company_id, entity_type, entity_id, rule_code) WHERE status = 'OPEN' DO NOTHING RETURNING *`,
    { type: QueryTypes.SELECT, transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, entityType, entityId, ruleCode: rule.code, severity: rule.severity, stewardId } }
  );
  return rows[0] || null;
}

async function announceOpened(tenant, issue, actorUserId, transaction) {
  const payload = { issueId: issue.id, entityType: issue.entity_type, entityId: issue.entity_id, ruleCode: issue.rule_code, severity: issue.severity };
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'governance.quality_issue.opened', entityType: AUDIT_ENTITY, entityId: issue.id,
    beforeJson: null, afterJson: payload, reason: `Problema de qualidade aberto: regra ${issue.rule_code} (${issue.severity}).`,
  }, transaction);
  await publishGovernanceEvent({
    groupId: tenant.groupId, companyId: tenant.companyId, aggregateType: AUDIT_ENTITY, aggregateId: issue.id, eventType: EVENT_ISSUE_OPENED, payload,
    idempotencyKey: `${EVENT_ISSUE_OPENED}:${issue.id}`,
  }, transaction);
  await handleIssueOpened(tenant, payload, transaction);
}

async function resolveIssue(tenant, issue, actorUserId, transaction) {
  await sequelize.query("UPDATE governance.quality_issues SET status = 'RESOLVED', resolved_at = now(), updated_at = now() WHERE id = :id", { transaction, replacements: { id: issue.id } });
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'governance.quality_issue.resolved', entityType: AUDIT_ENTITY, entityId: issue.id,
    beforeJson: { status: ISSUE_STATUS.OPEN, ruleCode: issue.rule_code }, afterJson: { status: ISSUE_STATUS.RESOLVED, ruleCode: issue.rule_code },
    reason: `Problema de qualidade resolvido: a regra ${issue.rule_code} passou a ser atendida.`,
  }, transaction);
}

/**
 * Compara as regras que falharam agora com as issues abertas do cadastro (M9-D806 §3.3): abre as que faltam (evento, auditoria e, se grave, fila de
 * revisão) e resolve as que a regra já não reprova (dado corrigido, regra desligada ou inaplicável). Chamada com o score do cadastro já travado.
 */
async function reconcileIssues(tenant, entityType, entityId, failedRules, { actorUserId = null } = {}, transaction) {
  const open = await lockOpen(tenant, entityType, entityId, transaction);
  const failedCodes = new Set(failedRules.map((rule) => rule.code));
  const openCodes = new Set(open.map((issue) => issue.rule_code));
  const resolved = [];
  const opened = [];
  for (const issue of open) {
    if (failedCodes.has(issue.rule_code)) continue;
    await resolveIssue(tenant, issue, actorUserId, transaction);
    resolved.push({ id: issue.id, ruleCode: issue.rule_code });
  }
  let stewardId;
  for (const rule of failedRules) {
    if (openCodes.has(rule.code)) continue;
    if (stewardId === undefined) stewardId = await stewardOfEntity(tenant, entityType, transaction);
    const issue = await insertIssue(tenant, entityType, entityId, rule, stewardId, transaction);
    if (!issue) continue;
    await announceOpened(tenant, issue, actorUserId, transaction);
    opened.push({ id: issue.id, ruleCode: rule.code, severity: rule.severity });
  }
  return { opened, resolved };
}

module.exports = { reconcileIssues };
