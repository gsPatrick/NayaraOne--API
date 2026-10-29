'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { getSetting } = require('../../settings/settings.service');
const { SECTOR_CODES, ADMIN_ROLE } = require('./bcp.constants');
const { SECTOR_ROLES_KEY, BCP_SETTING_DEFAULTS, parseSectorRoles } = require('./bcp.settings');
const { sectorForbidden } = require('./bcp.errors');

/** Catálogo dos seis setores (governance.bcp_sectors), na ordem do livro. */
function listSectors(transaction) {
  return sequelize.query(
    'SELECT sector, form_prefix AS "formPrefix", runbook_file AS "runbookFile", label FROM governance.bcp_sectors ORDER BY position',
    { type: QueryTypes.SELECT, transaction }
  );
}

/** Nomes (maiúsculos) dos papéis ativos do usuário na empresa. */
async function activeRoleNames(userId, tenant, transaction) {
  const rows = await sequelize.query(
    `SELECT DISTINCT upper(r.name) AS name FROM core.user_memberships m JOIN core.roles r ON r.id = m.role_id
      WHERE m.user_id = :userId AND m.company_id = :companyId AND m.deleted_at IS NULL AND m.status = 'ACTIVE' AND r.deleted_at IS NULL`,
    { type: QueryTypes.SELECT, transaction, replacements: { userId, companyId: tenant.companyId } }
  );
  return rows.map((row) => row.name);
}

/**
 * userSectors (M9-D830 §3.0b): os setores do usuário, derivados do PAPEL que ele tem, pelo parâmetro governanca.bcp.setor_por_papel. O administrador (papel ADMIN)
 * pertence aos seis. Sem papel mapeado: lista vazia (nenhuma operação de BCP). Função única usada por D831, D832, D834 e D904.
 */
async function userSectors(userId, tenant, transaction) {
  const roles = await activeRoleNames(userId, tenant, transaction);
  if (roles.includes(ADMIN_ROLE)) return [...SECTOR_CODES];
  const raw = await getSetting(SECTOR_ROLES_KEY, tenant, transaction, BCP_SETTING_DEFAULTS[SECTOR_ROLES_KEY]);
  const map = parseSectorRoles(raw) || parseSectorRoles(BCP_SETTING_DEFAULTS[SECTOR_ROLES_KEY]);
  return SECTOR_CODES.filter((sector) => (map[sector] || []).some((name) => roles.includes(name)));
}

/** Recusa com 403 GOV_BCP_SECTOR_FORBIDDEN se o setor não é de um dos setores do usuário. Devolve os setores do usuário. */
async function assertUserSector(userId, tenant, sector, transaction) {
  const sectors = await userSectors(userId, tenant, transaction);
  if (!sectors.includes(sector)) throw sectorForbidden();
  return sectors;
}

module.exports = { listSectors, userSectors, assertUserSector };
