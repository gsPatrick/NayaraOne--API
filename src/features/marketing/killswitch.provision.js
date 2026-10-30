'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');
const { activeAdminIds } = require('../core-governance/governance.users');
const { registerSwitchProvisioner } = require('../core-governance/feature-flags/kill-switch/killSwitch.provision');
const { ensureAll } = require('./killswitch.registry');

const PERMISSION = 'marketing:killswitch:manage';

/** Responsável pelos kill switches da empresa: o membro ativo mais antigo cujo papel tem `marketing:killswitch:manage`; sem ele, o administrador ativo mais antigo. */
async function responsibleFor(tenant, transaction) {
  const rows = await sequelize.query(
    `SELECT m.user_id FROM core.user_memberships m JOIN core.users u ON u.id = m.user_id
      WHERE m.company_id = :companyId AND m.deleted_at IS NULL AND m.status = 'ACTIVE' AND u.deleted_at IS NULL AND u.status = 'ACTIVE'
        AND EXISTS (SELECT 1 FROM core.role_permissions rp JOIN core.permissions p ON p.id = rp.permission_id WHERE rp.role_id = m.role_id AND p.code = :code)
      ORDER BY m.created_at, m.user_id LIMIT 1`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, code: PERMISSION } }
  );
  if (rows[0]) return rows[0].user_id;
  return (await activeAdminIds(tenant, transaction))[0] || null;
}

/** Registra os 10 kill switches (global e 9 canais) da empresa no catálogo da M9-D872, para o teste periódico cobri-los; sem responsável ativo não há como registrar. */
async function provisionKillSwitches(tenant, transaction) {
  const owner = await responsibleFor(tenant, transaction);
  if (!owner) return { registered: false, reason: 'NO_RESPONSIBLE_USER' };
  const rows = await ensureAll(tenant, owner, transaction);
  return { registered: true, keys: rows.map((r) => r.key) };
}

registerSwitchProvisioner(provisionKillSwitches);

module.exports = { provisionKillSwitches, responsibleFor };
