'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { DOMAIN_BY_ENTITY } = require('./merge.constants');

/** Curador (STEWARD) vigente do domínio do cadastro (PERSON -> PESSOAS, PROPERTY -> IMOVEIS, SUPPLIER -> FORNECEDORES); o mais antigo, ou null. */
async function stewardOfEntity(tenant, entityType, transaction) {
  const rows = await sequelize.query(
    `SELECT a.user_id FROM governance.data_domain_assignments a JOIN governance.data_domains d ON d.id = a.domain_id
      WHERE a.company_id = :companyId AND d.code = :code AND a.role = 'STEWARD' AND a.valid_until IS NULL ORDER BY a.valid_from, a.id LIMIT 1`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, code: DOMAIN_BY_ENTITY[entityType] } }
  );
  return rows.length ? rows[0].user_id : null;
}

module.exports = { stewardOfEntity };
