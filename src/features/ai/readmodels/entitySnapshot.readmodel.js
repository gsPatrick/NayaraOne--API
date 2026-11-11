'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize, FinancialEntry } = require('../../../models');
const { buildEntrySnapshot } = require('../../../modules/finance/domain/payment-intent');
const { ENTITY_TABLES } = require('./entityOwnership.readmodel');

/**
 * Retrato das entidades-alvo de uma proposta da NAY (M9-D019): só os campos que mudam o significado da ação (situação, valor,
 * exclusão). Campos operacionais (updated_at, lock_version) ficam de fora de propósito, senão qualquer edição inócua tornaria
 * a proposta desatualizada. Colunas e tabelas vêm desta lista fechada; leitura sempre na transação do tenant (RLS).
 */
const COLUMNS = Object.freeze({
  crmOpportunity: 'stage, temperature, expected_value::text AS "expectedValue", closed_at AS "closedAt", deleted_at AS "deletedAt"',
  person: 'status, merged_into_id AS "mergedIntoId", deleted_at AS "deletedAt"',
  property: 'publication_status AS "publicationStatus", availability_status AS "availabilityStatus", deleted_at AS "deletedAt"',
  constructionProject: 'status, budget_amount::text AS "budgetAmount", deleted_at AS "deletedAt"',
  legalContract: 'status, total_value::text AS "totalValue", deleted_at AS "deletedAt"',
  financingCase: 'status',
});

/** Retrato atual da entidade, ou `{ exists: false }` quando não existe (ou não é da empresa: o RLS esconde). */
async function readEntitySnapshot(entity, id, transaction) {
  if (entity === 'financialEntry') {
    const entry = await FinancialEntry.findByPk(id, { transaction });
    return entry ? buildEntrySnapshot(entry) : { exists: false };
  }
  const columns = COLUMNS[entity];
  if (!columns || !ENTITY_TABLES[entity]) throw new Error(`Entidade sem retrato no escopo da NAY: ${entity}`);
  const rows = await sequelize.query(`SELECT ${columns} FROM ${ENTITY_TABLES[entity]} WHERE id = :id LIMIT 1`, { replacements: { id }, transaction, type: QueryTypes.SELECT });
  return rows.length ? rows[0] : { exists: false };
}

module.exports = { readEntitySnapshot };
