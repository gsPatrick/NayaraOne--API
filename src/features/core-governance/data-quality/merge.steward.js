'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { DOMAIN_BY_ENTITY } = require('./merge.constants');
const errors = require('./merge.errors');

/** Só o owner ou um steward vigente do domínio do cadastro decide (M9-D804): PERSON -> PESSOAS, PROPERTY -> IMOVEIS, SUPPLIER -> FORNECEDORES. */
async function assertDomainSteward(tenant, entityType, userId, transaction) {
  const rows = await sequelize.query(
    `SELECT 1 FROM governance.data_domain_assignments a JOIN governance.data_domains d ON d.id = a.domain_id
      WHERE a.company_id = :companyId AND d.code = :code AND a.user_id = :userId AND a.valid_until IS NULL AND a.role IN ('OWNER', 'STEWARD') LIMIT 1`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, code: DOMAIN_BY_ENTITY[entityType], userId } }
  );
  if (!rows.length) throw errors.notSteward();
}

module.exports = { assertDomainSteward };
