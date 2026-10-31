'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const errors = require('./rollback.errors');
const { DECISIONS, AUDIT, AUDIT_ENTITY } = require('./rollback.constants');
const { ensureTypes } = require('./rollback.seed');
const readiness = require('./readiness');

const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

/** A última decisão do GO/NO-GO da empresa (ou null). */
const latestDecision = async (tenant, transaction) => (await select(
  'SELECT id, decision, reason, decided_by AS "decidedBy", decided_at AS "decidedAt" FROM governance.cutover_decisions WHERE company_id = :companyId ORDER BY decided_at DESC, id DESC LIMIT 1',
  { companyId: tenant.companyId }, transaction
))[0] || null;

/** T0 (M9-D907 §3.2): o instante do GO, isto é, o da última decisão quando ela é GO; antes do GO, ou depois de um NO_GO, não há T0. */
async function currentT0(tenant, transaction) {
  const last = await latestDecision(tenant, transaction);
  return last && last.decision === DECISIONS.GO ? last.decidedAt : null;
}

/**
 * POST /migration/cutover/decision (DI-D907-1): registra a decisão da atividade GO_NO_GO. GO só vale com o pré-requisito do corte (§3.4): todo tipo de operação externa com
 * compensação e responsável e as demais verificações registradas em `readiness` (a simulação de rollback no DRY3, M9-D908); senão 409 GOV_CUTOVER_NOT_READY. O instante
 * gravado é o do banco e passa a ser T0. NO_GO encerra o T0 vigente.
 */
async function decide(tenant, actor, body, transaction) {
  const decision = body && typeof body.decision === 'string' ? body.decision.trim().toUpperCase() : '';
  if (!DECISIONS[decision]) throw errors.decisionInvalid();
  await ensureTypes(tenant, transaction);
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { transaction, replacements: { key: `cutover-decision:${tenant.companyId}` } });
  if (decision === DECISIONS.GO) {
    const gaps = await readiness.collect(tenant, transaction);
    if (gaps.length) throw errors.notReady({ gaps });
  }
  const reason = body && typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 1000) : null;
  const before = await latestDecision(tenant, transaction);
  const [row] = await select(
    `INSERT INTO governance.cutover_decisions (group_id, company_id, decision, reason, decided_by) VALUES (:groupId, :companyId, :decision, :reason, :userId)
     RETURNING id, decision, reason, decided_by AS "decidedBy", decided_at AS "decidedAt"`,
    { groupId: tenant.groupId, companyId: tenant.companyId, decision, reason, userId: actor && actor.userId ? actor.userId : null }, transaction
  );
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor && actor.userId, action: AUDIT.DECISION, entityType: AUDIT_ENTITY.DECISION, entityId: row.id,
    beforeJson: before ? { decision: before.decision, decidedAt: before.decidedAt } : null, afterJson: { decision, decidedAt: row.decidedAt }, reason: reason || `Decisão do corte: ${decision}.`,
  }, transaction);
  return { ...row, t0: decision === DECISIONS.GO ? row.decidedAt : null };
}

module.exports = { latestDecision, currentT0, decide };
