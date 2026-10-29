'use strict';

/**
 * M9-D623 / M9-D611 — origem dos quatro KPIs de resultado do Financeiro: quais registros do Financeiro reproduzem cada número. Os filtros ficam
 * guardados em rm_finance_health.source_criteria (financeHealth.criteria.js). Margem por setor: lançamentos próprios liquidados da competência
 * (entradas somam, saídas subtraem). Comissões: parcelas (provisionadas = PENDING; pagas = PAID no mês). Repasses: PENDING e APPROVED.
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);

const SPECS = [
  {
    metricCode: 'fin.sector_margin', type: 'LEDGER_ENTRIES', table: 'finance.financial_entries', valueColumn: 'amount', valueSign: { column: 'nature', negative: ['PAYABLE'] },
    columns: { status: 'status', nature: 'nature', equals: { thirdParty: 'is_third_party_funds', reversal: 'reversal_of_entry_id', competenceMonth: 'competence_month' } },
    describe: (f) => `Lançamentos próprios liquidados (receita menos custo, sem terceiros nem estornos) da competência ${(f.equals || {}).competenceMonth}`,
  },
  {
    metricCode: 'fin.commissions_provisioned', type: 'COMMISSION_INSTALLMENTS', table: 'finance.commission_installments', valueColumn: 'amount', columns: { status: 'status' },
    describe: () => 'Parcelas de comissão pendentes de comissões reconhecidas (ainda não pagas)',
  },
  {
    metricCode: 'fin.commissions_paid', type: 'COMMISSION_INSTALLMENTS', table: 'finance.commission_installments', valueColumn: 'amount', columns: { status: 'status', period: 'paid_at' },
    describe: (f) => `Parcelas de comissão pagas de ${day(f.period.from)} até antes de ${day(f.period.to)}`,
  },
  {
    metricCode: 'fin.owner_repasses_pending', type: 'OWNER_REPASSES', table: 'finance.owner_repasses', valueColumn: 'net_amount', columns: { status: 'status' },
    describe: () => 'Repasses ao proprietário gerados e ainda não pagos (pendentes ou aprovados)',
  },
];

for (const spec of SPECS) if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);

module.exports = { RESULT_SOURCE_CODES: SPECS.map((s) => s.metricCode) };
