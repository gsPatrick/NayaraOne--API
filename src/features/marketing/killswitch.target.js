'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');
const flagsRepo = require('../core-governance/feature-flags/flags.repository');
const { SCOPES, GLOBAL_KEY, channelKey } = require('./killswitch.constants');
const registry = require('./killswitch.registry');
const errors = require('./killswitch.errors');

const q = (sql, transaction, replacements) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const TABLES = Object.freeze({ [SCOPES.CAMPAIGN]: 'campaigns', [SCOPES.AUTOMATION]: 'automation_flows' });

/**
 * Localiza e TRAVA (FOR UPDATE) o alvo do kill switch. GLOBAL e CHANNEL: a flag do registro (criada na primeira vez). CAMPAIGN e AUTOMATION: a linha da campanha ou do fluxo
 * da empresa. Alvo inexistente: 404 MKT_KILL_SWITCH_TARGET_NOT_FOUND. Devolve { kind, id, active, label, row }.
 */
async function lockTarget(tenant, { scope, targetId }, actorUserId, transaction) {
  if (scope === SCOPES.GLOBAL || scope === SCOPES.CHANNEL) {
    const key = scope === SCOPES.GLOBAL ? GLOBAL_KEY : channelKey(targetId);
    const created = await registry.ensureSwitch(tenant, key, actorUserId, transaction);
    const row = await flagsRepo.findById(tenant, 'FLAG', created.id, transaction, { lock: true });
    return { kind: 'FLAG', id: row.id, active: row.value === true, label: key, row };
  }
  const rows = await q(
    `SELECT id, code, name, kill_switch_active FROM marketing.${TABLES[scope]} WHERE id = :id AND company_id = :companyId AND deleted_at IS NULL FOR UPDATE`,
    transaction, { id: targetId, companyId: tenant.companyId }
  );
  if (!rows[0]) throw errors.targetNotFound({ scope, targetId });
  return { kind: scope, id: rows[0].id, active: rows[0].kill_switch_active === true, label: rows[0].code, row: rows[0] };
}

/** Grava o estado nas colunas da campanha ou do fluxo; ao reativar, limpa o "quando, quem e por quê" do bloqueio atual (o histórico fica no log e na auditoria). */
async function writeColumns(tenant, scope, id, { active, actorUserId, reason, at }, transaction) {
  await sequelize.query(
    `UPDATE marketing.${TABLES[scope]} SET kill_switch_active = :active, kill_switch_at = :at, kill_switch_by = :by, kill_switch_reason = :reason, updated_by = :actor, updated_at = now()
      WHERE id = :id AND company_id = :companyId`,
    { transaction, replacements: { id, companyId: tenant.companyId, active, at: active ? at : null, by: active ? actorUserId : null, actor: actorUserId || null, reason: active ? reason : null } }
  );
}

module.exports = { lockTarget, writeColumns };
