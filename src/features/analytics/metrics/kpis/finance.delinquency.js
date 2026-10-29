'use strict';

/**
 * M9-D622 — definição, entradas e parâmetros dos KPIs de inadimplência do Financeiro: valor inadimplente (fin.overdue_receivables), taxa de inadimplência
 * (fin.delinquency_rate) e necessidade para respirar (fin.breathing_need). Os 15 campos do livro (M9-D603): fonte rm_finance_health, fórmula versionada no
 * código (formulas/fin*.js, id = código do indicador), dimensões, unidade, owner (parâmetro analytics.owner.<código>), política de atualização (evento + agenda
 * de 15 min, M9-D607) e regra de qualidade. Versão 1; os três são CRITICAL (tabela da M9-D712) e nascem com drill-down. A necessidade para respirar é composta:
 * herda a qualidade de caixa livre, contas a pagar em 30 dias e contas a pagar vencidas (componente que só existe aqui, sem métrica própria).
 */
const { readOverdueBandLimits } = require('../../read-models/financeDelinquency.settings');
require('../sourceSpecs.finance.delinquency');

const REFERENCE_REPORT = 'Relatório de contas a receber e a pagar do Financeiro (M9-D708): inadimplência, taxa e necessidade para respirar';
const MAX_STALENESS_MINUTES = 15;
const quality = (requiredFields) => ({ referenceReport: REFERENCE_REPORT, maxStalenessMinutes: MAX_STALENESS_MINUTES, requiredFields, allowNull: true });
const BASE = Object.freeze({ criticality: 'CRITICAL', drilldownEnabled: true });

const DEFINITIONS = Object.freeze([
  {
    ...BASE, metricCode: 'fin.overdue_receivables', name: 'Valor inadimplente (a receber vencido)', formulaId: 'fin.overdue_receivables', valueNature: 'ACTUAL', unit: 'BRL',
    description: 'O que já deveria ter entrado e não entrou: soma, em reais, das entradas próprias pendentes com vencimento anterior a hoje, por faixa de atraso e por contrato.',
    formulaSemantic: 'Σ amount dos lançamentos de ENTRADA PENDING próprios (isThirdPartyFunds=false, estorno fora) com vencimento (calendário de São Paulo) anterior a hoje, sem limite de idade; quem vence hoje não é inadimplente. Faixas de atraso em analytics.inadimplencia.faixas_atraso_dias (padrão 1-30, 31-60, 61-90, 90+).',
    dimensions: ['empresa', 'contrato', 'faixa de atraso'], qualityRule: quality(['receivables_without_due_date', 'overdue_receivables_detail']),
  },
  {
    ...BASE, metricCode: 'fin.delinquency_rate', name: 'Taxa de inadimplência', formulaId: 'fin.delinquency_rate', valueNature: 'ACTUAL', unit: 'PERCENT',
    description: 'Quanto do que vencia nos últimos 90 dias (a janela é do administrador) segue sem pagamento, em percentual da base cobrada na mesma janela mais hoje.',
    formulaSemantic: 'taxa = vencidoNaJanela ÷ base × 100 (2 casas): vencidoNaJanela = Σ entradas próprias PENDING com vencimento em [hoje − janela + 1, hoje − 1]; base = Σ entradas próprias (exceto REVERSED e CANCELLED) com vencimento na mesma janela mais hoje. O vencido anterior à janela fica fora e em details.overdueOutsideWindow. Base zero é INCOMPLETE.',
    dimensions: ['empresa', 'contrato', 'faixa de atraso'], qualityRule: quality(['receivables_base_90d', 'overdue_amount_in_window_90d']),
  },
  {
    ...BASE, metricCode: 'fin.breathing_need', name: 'Necessidade para respirar', formulaId: 'fin.breathing_need', valueNature: 'PROJECTED', unit: 'BRL',
    description: 'Quanto de dinheiro a empresa precisa conseguir para atravessar os próximos 30 dias sem ficar no vermelho, sem contar nenhum recebível a vencer.',
    formulaSemantic: 'max(0, contas a pagar vencidas + fin.payables_30d + comissões a pagar até hoje+29 sem lançamento PENDING correspondente − fin.free_cash). Dinheiro de terceiros fora. Componente DEGRADED (caixa livre, contas a pagar em 30 dias ou vencidas) deixa o indicador DEGRADED e sem valor.',
    dimensions: ['empresa'], qualityRule: quality(['overdue_payables', 'payables_30d', 'commissions_unlinked_30d', 'free_cash']),
  },
]);

const CODES = DEFINITIONS.map((d) => d.metricCode);
const COMPONENT_UNITS = Object.freeze({ 'fin.overdue_payables': 'BRL', 'fin.payables_30d': 'BRL', 'fin.commissions_unlinked_30d': 'BRL', 'fin.free_cash': 'BRL' });

const component = (value, status = 'OK') => ({ value, status });
const dayOf = (row) => row.overdue_receivables_detail || {};

/** Os componentes da necessidade são calculados pelas fórmulas de cada um (caixa livre e contas a pagar em 30 dias) e a conta de vencidas pelo mesmo critério de vencimento. */
function breathingComponents(row, asOfDate, settings) {
  const cash = require('./finance.cash').INPUTS['fin.free_cash'](row, asOfDate);
  const freeCash = require('../formulas/finFreeCash').compute(cash, { tolerance: settings.cashTolerance });
  const p30 = require('../formulas/finPayables30d').compute(require('./finance.horizon').INPUTS['fin.payables_30d'](row, asOfDate));
  const withoutDue = Number(row.payables_without_due_date || 0);
  return {
    freeCash: component(freeCash.value, freeCash.status), payables30d: component(p30.value, p30.status),
    overduePayables: withoutDue > 0 ? component(null, 'INCOMPLETE') : component(String(row.overdue_payables)),
    commissions: component(String(row.commissions_unlinked_30d)),
  };
}

const INPUTS = Object.freeze({
  'fin.overdue_receivables': (row, asOfDate) => ({ asOfDate, total: String(row.overdue_amount), withoutDueDate: row.receivables_without_due_date, detail: dayOf(row) }),
  'fin.delinquency_rate': (row, asOfDate) => ({
    asOfDate, overdueInWindow: String(row.overdue_amount_in_window_90d), overdueOutsideWindow: String(row.overdue_amount_outside_window_90d), base: String(row.receivables_base_90d),
    withoutDueDate: row.receivables_without_due_date, detail: dayOf(row),
  }),
  'fin.breathing_need': (row, asOfDate, _extra, settings) => ({ asOfDate, components: breathingComponents(row, asOfDate, settings) }),
});

const PARAMS = Object.freeze({
  'fin.overdue_receivables': (s) => ({ bands: s.overdueBands }),
  'fin.delinquency_rate': (s) => ({ bands: s.overdueBands }),
  'fin.breathing_need': () => ({}),
});

module.exports = { DEFINITIONS, INPUTS, PARAMS, CODES, COMPONENT_UNITS, readOverdueBandLimits };
