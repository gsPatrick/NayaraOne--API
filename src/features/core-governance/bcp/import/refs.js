'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { commandRejected } = require('../bcp.errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Referências do papel a entidades do sistema (DI-D832-1): o campo do formulário aceita o id (UUID) da entidade ou o seu código legível (imóvel: código interno; contrato:
 * número; obra: código; centro de custo: código; processo jurídico: número). Código que não existe ou que serve a mais de uma entidade recusa o comando (nunca adivinha).
 */
const KINDS = {
  property: { table: 'real_estate.properties', code: 'internal_code', label: 'imóvel' },
  contract: { table: 'legal.contracts', code: 'contract_number', label: 'contrato' },
  project: { table: 'construction.projects', code: 'code', label: 'obra' },
  costCenter: { table: 'finance.cost_centers', code: 'code', label: 'centro de custo' },
  legalCase: { table: 'legal.legal_cases', code: 'case_number', label: 'processo jurídico' },
  financingCase: { table: 'correspondent.financing_cases', code: null, label: 'processo de financiamento', hard: true },
  financialEntry: { table: 'finance.financial_entries', code: null, label: 'lançamento financeiro', hard: true },
};

/** Devolve a linha da entidade (id e colunas básicas) ou recusa com GOV_BCP_COMMAND_REJECTED. */
async function resolveRef(kind, ref, tenant, transaction) {
  const spec = KINDS[kind];
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (!spec || !value) throw commandRejected(`referência de ${spec ? spec.label : kind} ausente`);
  const byId = UUID.test(value);
  if (!byId && !spec.code) throw commandRejected(`informe o identificador (UUID) do ${spec.label}`);
  const rows = await sequelize.query(
    `SELECT * FROM ${spec.table} WHERE company_id = :companyId ${spec.hard ? '' : 'AND deleted_at IS NULL'} AND ${byId ? 'id = :value' : `lower(${spec.code}) = lower(:value)`} LIMIT 2`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, value } }
  );
  if (rows.length === 0) throw commandRejected(`${spec.label} "${value}" não encontrado`);
  if (rows.length > 1) throw commandRejected(`${spec.label} "${value}" é ambíguo: informe o identificador (UUID)`);
  return rows[0];
}

module.exports = { resolveRef, UUID };
