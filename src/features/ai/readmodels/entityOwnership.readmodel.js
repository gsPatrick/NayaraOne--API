'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/**
 * Empresa dona de uma ENTIDADE referenciada por id nos argumentos de uma tool (M9-D017, passo 3). A leitura é feita na transação
 * do tenant, sob RLS: id de outra empresa (ou inexistente) volta `null`, sem distinção. Nomes de tabela vêm só desta lista fechada.
 */
const ENTITY_TABLES = Object.freeze({
  crmOpportunity: 'crm.opportunities',
  person: 'people.persons',
  property: 'real_estate.properties',
  constructionProject: 'construction.projects',
  legalContract: 'legal.contracts',
  legalInspection: 'legal.inspections', // Fechamento M5: legal.compareInspections
  financingCase: 'correspondent.financing_cases',
  financialEntry: 'finance.financial_entries',
  file: 'people.files',
});

async function findEntityCompany(entity, id, transaction) {
  const tabela = ENTITY_TABLES[entity];
  if (!tabela) throw new Error(`Entidade desconhecida no escopo da NAY: ${entity}`);
  const rows = await sequelize.query(`SELECT company_id AS "companyId" FROM ${tabela} WHERE id = :id LIMIT 1`, { replacements: { id }, transaction, type: QueryTypes.SELECT });
  return rows.length ? rows[0].companyId : null;
}

module.exports = { findEntityCompany, ENTITY_TABLES };
