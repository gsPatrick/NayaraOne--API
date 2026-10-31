'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const repository = require('./legalHold.repository');
const errors = require('./legalHold.errors');
const { STATUS } = require('./legalHold.constants');

/**
 * Exclusão de empresa e de grupo (M9-D912): qualquer retenção legal ATIVA numa empresa impede apagá-la (apagar a empresa descarta tudo o que ela guarda). A RLS esconde as
 * retenções de outra empresa, então a leitura troca, só durante a checagem, o contexto da empresa na própria transação da exclusão e o devolve em seguida.
 */
const setContext = (name, value, transaction) => sequelize.query('SELECT set_config(:name, :value, true)', { replacements: { name, value: value || '' }, transaction });

async function assertCompanyNotOnHold(companyId, transaction) {
  const previous = await repository.contextCompany(transaction);
  await setContext('app.company_id', companyId, transaction);
  try {
    const rows = await sequelize.query('SELECT count(*)::int AS n FROM governance.legal_holds WHERE company_id = :companyId AND status = :active', { type: QueryTypes.SELECT, transaction, replacements: { companyId, active: STATUS.ACTIVE } });
    if (rows[0].n > 0) throw errors.disposalBlocked({ entityType: 'COMPANY', count: rows[0].n });
  } finally {
    await setContext('app.company_id', previous, transaction);
  }
}

/** Grupo: nenhuma das empresas dele pode ter retenção ativa. Roda numa transação própria só de leitura (a exclusão de grupo não tem contexto de empresa). */
async function assertGroupNotOnHold(groupId) {
  await sequelize.transaction(async (transaction) => {
    await setContext('app.group_id', groupId, transaction);
    const companies = await sequelize.query('SELECT id FROM core.companies WHERE group_id = :groupId', { type: QueryTypes.SELECT, transaction, replacements: { groupId } });
    for (const company of companies) await assertCompanyNotOnHold(company.id, transaction);
  });
}

module.exports = { assertCompanyNotOnHold, assertGroupNotOnHold };
