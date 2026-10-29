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

/** Saldo de abertura das contas da empresa: só quando o filtro liga `includeOpening` (parâmetro analytics.caixa.usar_saldo_abertura no momento do cálculo). */
const openingAddend = (filter) => ((filter.equals || {}).includeOpening ? {
  label: 'Saldo de abertura das contas bancárias',
  sql: 'SELECT COALESCE(SUM(a.opening_balance), 0)::text AS total FROM finance.bank_accounts a WHERE a.company_id = :companyId AND a.deleted_at IS NULL AND a.owner_person_id IS NULL',
  replacements: {},
} : null);

/** Pernas das transferências entre empresas já liquidadas (entrada soma, saída subtrai): mesmas regras de status e período do filtro. */
const intercompanyAddend = (filter) => ({
  label: 'Transferências entre empresas liquidadas',
  sql: `SELECT COALESCE(SUM(CASE WHEN e.entry_type = 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::text AS total FROM finance.financial_entries e
         WHERE e.company_id = :companyId AND e.nature = 'ADJUSTMENT' AND e.idempotency_key LIKE 'intercompany-transfer:%' AND e.reversal_of_entry_id IS NULL
           AND e.status IN (:addStatus)${filter.period && filter.period.to ? ' AND e.settled_at < :addTo' : ''}`,
  replacements: { addStatus: filter.status && filter.status.length ? filter.status : ['SETTLED'], addTo: filter.period ? filter.period.to : null },
});

const SPECS = [
  { // M9-D620: o ledger próprio liquidado mais as parcelas que não estão nele (abertura das contas e transferências entre empresas liquidadas)
    ...ENTRIES, metricCode: 'fin.free_cash', valueSign: { column: 'nature', negative: ['PAYABLE'] }, columns: { ...ENTRIES.columns, period: 'settled_at' },
    flags: ['includeOpening'], addends: [openingAddend, intercompanyAddend],
    describe: (f) => `Lançamentos próprios liquidados (entradas menos saídas, sem terceiros nem estornos)${(f.equals || {}).includeOpening ? ', mais o saldo de abertura das contas,' : ''} e as transferências entre empresas liquidadas, até ${day(f.period.to)}` },
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
  { // M9-D624: transações bancárias importadas sem nenhuma conciliação (unidade COUNT: o detalhe reconcilia pela contagem)
    metricCode: 'fin.reconciliations_pending', type: 'BANK_TRANSACTIONS', table: 'finance.bank_transactions', valueColumn: 'amount',
    columns: { period: 'transaction_date' }, unlinked: { table: 'finance.reconciliations', column: 'bank_transaction_id' },
    describe: (f) => `Transações bancárias importadas, sem conciliação, com data antes de ${day(f.period.to)}`,
  },
  { // M9-D624: casos de anomalia abertos no Financeiro
    metricCode: 'fin.anomalies_open', type: 'ANOMALY_CASES', table: 'finance.anomaly_cases', columns: { status: 'status', equals: { riskLevel: 'risk_level' } },
    describe: () => 'Casos de anomalia financeira com status aberto',
  },
  { metricCode: 'fin.breathing_need', components: ['fin.overdue_payables', 'fin.payables_30d', 'fin.commissions_unlinked_30d', 'fin.free_cash'] },
];

for (const spec of SPECS) if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);

module.exports = { FINANCE_SOURCE_CODES: SPECS.map((s) => s.metricCode) };
