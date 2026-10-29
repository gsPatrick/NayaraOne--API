'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** Acesso a governance.data_domains e governance.data_domain_assignments (a RLS isola a empresa; o filtro explícito vale de qualquer forma). */
async function ensureDomains(tenant, codes, transaction) {
  for (const code of codes) {
    await sequelize.query(
      'INSERT INTO governance.data_domains (group_id, company_id, code) VALUES (:groupId, :companyId, :code) ON CONFLICT (company_id, code) DO NOTHING',
      { transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, code } }
    );
  }
  return sequelize.query('SELECT id, code FROM governance.data_domains WHERE company_id = :companyId AND code IN (:codes)', {
    type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, codes },
  });
}

/** Trava a linha do domínio (troca de responsável é serializada por domínio). */
async function lockDomain(tenant, code, transaction) {
  const rows = await sequelize.query('SELECT id, code FROM governance.data_domains WHERE company_id = :companyId AND code = :code FOR UPDATE', {
    type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, code },
  });
  return rows[0] || null;
}

/** Designações vigentes (valid_until nulo) dos domínios, com o nome do usuário. */
async function currentAssignments(tenant, transaction, domainIds = null) {
  return sequelize.query(
    `SELECT a.id, a.domain_id, d.code, a.role, a.user_id, u.name AS user_name, a.valid_from, a.designated_by
       FROM governance.data_domain_assignments a
       JOIN governance.data_domains d ON d.id = a.domain_id
       JOIN core.users u ON u.id = a.user_id
      WHERE a.company_id = :companyId AND a.valid_until IS NULL ${domainIds ? 'AND a.domain_id IN (:domainIds)' : ''}
      ORDER BY d.code, a.role DESC, a.valid_from, a.id`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, domainIds } }
  );
}

async function openAssignment(tenant, { domainId, role, userId, designatedBy }, transaction) {
  const rows = await sequelize.query(
    `INSERT INTO governance.data_domain_assignments (group_id, company_id, domain_id, role, user_id, designated_by)
     VALUES (:groupId, :companyId, :domainId, :role, :userId, :designatedBy) RETURNING *`,
    { type: QueryTypes.SELECT, transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, domainId, role, userId, designatedBy: designatedBy || null } }
  );
  return rows[0];
}

/** Fecha (valid_until = agora) as designações vigentes pelos ids. Nunca apaga. */
async function closeAssignments(ids, reason, transaction) {
  if (!ids.length) return [];
  return sequelize.query(
    'UPDATE governance.data_domain_assignments SET valid_until = now(), close_reason = :reason WHERE id IN (:ids) AND valid_until IS NULL RETURNING id, domain_id, role, user_id',
    { type: QueryTypes.SELECT, transaction, replacements: { ids, reason } }
  );
}

/** Fecha todas as designações vigentes de um usuário na empresa. */
async function closeUserAssignments(tenant, userId, reason, transaction) {
  return sequelize.query(
    `UPDATE governance.data_domain_assignments SET valid_until = now(), close_reason = :reason
      WHERE company_id = :companyId AND user_id = :userId AND valid_until IS NULL RETURNING id, domain_id, role, user_id`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, userId, reason } }
  );
}

module.exports = { ensureDomains, lockDomain, currentAssignments, openAssignment, closeAssignments, closeUserAssignments };
