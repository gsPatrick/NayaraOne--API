'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { userSectors } = require('../../core-governance/bcp/bcp.sectors');
const { selectedUsers } = require('./canary.selection');

/** Usuários ativos da empresa (vínculo e usuário ativos). */
async function activeUserIds(tenant, transaction) {
  const rows = await sequelize.query(
    `SELECT DISTINCT m.user_id FROM core.user_memberships m JOIN core.users u ON u.id = m.user_id
      WHERE m.company_id = :companyId AND m.deleted_at IS NULL AND m.status = 'ACTIVE' AND u.deleted_at IS NULL AND u.status = 'ACTIVE'`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId } }
  );
  return rows.map((row) => row.user_id);
}

/** Os usuários do setor (M9-D830 §3.0b): quem tem o setor na função única `userSectors`. */
async function sectorMembers(tenant, sector, transaction) {
  const members = [];
  for (const userId of await activeUserIds(tenant, transaction)) {
     
    if ((await userSectors(userId, tenant, transaction)).includes(sector)) members.push(userId);
  }
  return members;
}

/** { members, selected }: os usuários do setor e os que o percentual põe no sistema novo. */
async function canaryOf(tenant, sector, percent, transaction) {
  const members = await sectorMembers(tenant, sector, transaction);
  return { members, selected: percent > 0 ? selectedUsers(members, percent) : [] };
}

module.exports = { activeUserIds, sectorMembers, canaryOf };
