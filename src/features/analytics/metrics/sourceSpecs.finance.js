'use strict';

/**
 * M9-D615 / M9-D611 — origem dos números do read model financeiro (rm_finance_health): quais registros do Financeiro reproduzem cada
 * componente. Os filtros que os alimentam ficam guardados no próprio read model (source_criteria). Cada demanda de KPI do Financeiro
 * (M9-D620 a M9-D624) liga o seu indicador a estes componentes; `fin.breathing_need` é o KPI composto (components[] de M9-D611 3.5).
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');

const ENTRIES = {
  type: 'LEDGER_ENTRIES', table: 'finance.financial_entries', valueColumn: 'amount',
  columns: { status: 'status', nature: 'nature', equals: { thirdParty: 'is_third_party_funds', reversal: 'reversal_of_entry_id' } },
};
const day = (iso) => (iso ? String(iso).slice(0, 10) : null);

function pendingSpec(metricCode, label) {
  return {
    ...ENTRIES, metricCode, columns: { ...ENTRIES.columns, period: 'due_at' },
    describe: (f) => `${label} próprios (PENDING, sem estornos) com vencimento ${f.period.from ? `de ${day(f.period.from)} ` : ''}antes de ${day(f.period.to)}`,
  };
}

const SPECS = [
  { ...ENTRIES, metricCode: 'fin.free_cash', valueSign: { column: 'nature', negative: ['PAYABLE'] }, columns: { ...ENTRIES.columns, period: 'settled_at' },
    describe: (f) => `Lançamentos próprios liquidados (entradas menos saídas, sem terceiros nem estornos) até ${day(f.period.to)}` },
  { ...ENTRIES, metricCode: 'fin.third_party_cash', valueSign: { column: 'nature', negative: ['PAYABLE'] }, columns: { ...ENTRIES.columns, period: 'settled_at' },
    describe: (f) => `Lançamentos de dinheiro de terceiros liquidados (recebido menos devolvido) até ${day(f.period.to)}` },
  ...[7, 30, 60].flatMap((n) => [
    pendingSpec(`fin.payables_${n}d`, `Contas a pagar em ${n} dias:`),
    pendingSpec(`fin.receivables_${n}d`, `Contas a receber em ${n} dias:`),
  ]),
  pendingSpec('fin.overdue_payables', 'Contas a pagar vencidas:'),
  pendingSpec('fin.overdue_receivables', 'Contas a receber vencidas:'),
  {
    metricCode: 'fin.commissions_unlinked_30d', type: 'COMMISSION_INSTALLMENTS', table: 'finance.commission_installments', valueColumn: 'amount',
    columns: { period: 'due_at', status: 'status', equals: { financialEntryId: 'financial_entry_id' } },
    describe: (f) => `Parcelas de comissão pendentes, sem lançamento a pagar, com vencimento antes de ${day(f.period.to)}`,
  },
  { metricCode: 'fin.breathing_need', components: ['fin.overdue_payables', 'fin.payables_30d', 'fin.commissions_unlinked_30d', 'fin.free_cash'] },
];

for (const spec of SPECS) if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);

module.exports = { FINANCE_SOURCE_CODES: SPECS.map((s) => s.metricCode) };
