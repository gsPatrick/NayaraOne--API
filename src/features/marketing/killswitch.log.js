'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');

const q = (sql, transaction, replacements) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

/** Histórico imutável (marketing.kill_switch_log): uma linha por mudança de estado (ou por acionamento que muda o motivo/origem). */
async function insertLog(tenant, e, transaction) {
  const rows = await q(
    `INSERT INTO marketing.kill_switch_log (group_id, company_id, scope, target_id, action, source, incident_id, compromised, reason, actor_user_id, active_before, active_after)
     VALUES (:groupId, :companyId, :scope, :target, :action, :source, :incident, :compromised, :reason, :actor, :before, :after) RETURNING *`,
    transaction, {
      groupId: tenant.groupId, companyId: tenant.companyId, scope: e.scope, target: e.targetId || null, action: e.action, source: e.source, incident: e.incidentId || null,
      compromised: Boolean(e.compromised), reason: e.reason, actor: e.actorUserId || null, before: e.before, after: e.after,
    }
  );
  return rows[0];
}

/** O último acionamento do alvo (para saber de onde veio o bloqueio que está ligado). */
async function lastActivation(tenant, scope, targetId, transaction) {
  const rows = await q(
    `SELECT * FROM marketing.kill_switch_log WHERE company_id = :companyId AND scope = :scope AND COALESCE(target_id, '') = :target AND action = 'ACTIVATE'
      ORDER BY seq DESC LIMIT 1`,
    transaction, { companyId: tenant.companyId, scope, target: targetId || '' }
  );
  return rows[0] || null;
}

const listLog = (tenant, { scope, targetId } = {}, transaction) => q(
  `SELECT * FROM marketing.kill_switch_log WHERE company_id = :companyId AND (CAST(:scope AS text) IS NULL OR scope = :scope) AND (CAST(:target AS text) IS NULL OR target_id = :target) ORDER BY seq`,
  transaction, { companyId: tenant.companyId, scope: scope || null, target: targetId || null }
);

module.exports = { insertLog, lastActivation, listLog };
