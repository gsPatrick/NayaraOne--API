'use strict';

/**
 * M9-D622 / M9-D611 / M9-D690 — origem da taxa de inadimplência (fin.delinquency_rate): as entradas próprias da janela (vencimento de hoje − janela + 1 até hoje, inclusive),
 * sem estorno nem cancelamento, que são a base da conta. O filtro (assinado) fica em rm_finance_health.source_criteria. A taxa é PERCENT, então o detalhe reconcilia
 * refazendo a fórmula sobre as linhas (status, valor e dia de vencimento em São Paulo): vencido = PENDING com vencimento anterior à data-base. O valor inadimplente e a
 * necessidade para respirar usam as origens do Financeiro registradas em sourceSpecs.finance.js (vencidos, contas a pagar, comissões e caixa livre).
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');
const { registerDrilldownDetail } = require('./drilldown.details');

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);

const SPEC = {
  metricCode: 'fin.delinquency_rate', type: 'LEDGER_ENTRIES', table: 'finance.financial_entries',
  columns: { status: 'status', nature: 'nature', period: 'due_at', equals: { thirdParty: 'is_third_party_funds', reversal: 'reversal_of_entry_id' } },
  formulaId: 'fin.delinquency_rate', rowColumns: ['status', 'amount'], rowExpressions: { due_day: "(t.\"due_at\" AT TIME ZONE 'America/Sao_Paulo')::date" },
  describe: (f) => `Entradas próprias (sem estornos nem cancelamentos) com vencimento de ${day(f.period && f.period.from)} até antes de ${day(f.period && f.period.to)}: a base da taxa de inadimplência`,
};

if (!getSourceSpec(SPEC.metricCode)) registerSourceSpec(SPEC);
registerDrilldownDetail(SPEC.metricCode, { columns: ['is_third_party_funds', 'due_at', 'settled_at', 'status'], link: '/painel/financeiro/lancamentos/{id}' });

module.exports = { DELINQUENCY_SOURCE_CODES: [SPEC.metricCode] };
