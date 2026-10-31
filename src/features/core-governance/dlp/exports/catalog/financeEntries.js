'use strict';

const { collectFinancialEntries, countFinancialEntries } = require('../../../../finance/financeExport.service');
const { pick } = require('./filters');

/**
 * Exportação financeira (lançamentos), antes GET /finance/exports/entries. A descrição é texto livre e pode trazer dado pessoal: sai RESTRICTED (mascarada para quem
 * não tem `governance:dlp:view-restricted`). A classe de cada coluna é o padrão do catálogo enquanto o registro de classificação (M9-D910) não a substitui.
 */
module.exports = {
  code: 'finance.entries',
  label: 'Lançamentos financeiros',
  onDemand: true,
  formats: ['CSV', 'XLSX', 'PDF'],
  permission: 'finance:read',
  registryTable: 'finance.financial_entries',
  sourceFiles: ['features/finance/financeExport.service.js', 'features/finance/financeExport.routes.js'],
  lineage: {
    area: 'MONEY', ownerDomain: 'FINANCEIRO', criticality: 'CRITICAL', description: 'Exportação dos lançamentos financeiros (CSV, XLSX ou PDF) pelo POST /exports, com finalidade, MFA, expiração e auditoria.',
    readModel: { code: 'finance.financial_entries', description: 'Tabela de lançamentos financeiros: o conjunto de onde a exportação é lida.' },
    columns: ['finance.financial_entries.amount', 'finance.financial_entries.status', 'finance.financial_entries.due_at', 'finance.financial_entries.settled_at', 'finance.financial_entries.description'],
  },
  columns: [
    { key: 'id', label: 'Id', classification: 'HIGH' },
    { key: 'competenceMonth', label: 'Competência', classification: 'HIGH' },
    { key: 'nature', label: 'Natureza', classification: 'HIGH' },
    { key: 'entryType', label: 'Tipo', classification: 'HIGH' },
    { key: 'status', label: 'Situação', classification: 'HIGH' },
    { key: 'amount', label: 'Valor', classification: 'HIGH', numeric: true },
    { key: 'dueAt', label: 'Vencimento', classification: 'HIGH' },
    { key: 'settledAt', label: 'Liquidação', classification: 'HIGH' },
    { key: 'description', label: 'Descrição', classification: 'RESTRICTED' },
    { key: 'isThirdPartyFunds', label: 'Dinheiro de terceiros', classification: 'HIGH' },
  ],
  parseFilter: (filter) => pick(filter, ['competenceMonth', 'nature', 'status'], { competenceMonth: /^\d{4}-\d{2}$/ }),
  estimate: (_ctx, filter, transaction) => countFinancialEntries(filter, transaction),
  collect: async (_ctx, filter, transaction) => ({ rows: await collectFinancialEntries(filter, transaction) }),
};
