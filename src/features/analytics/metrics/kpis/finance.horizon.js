'use strict';

/**
 * M9-D621 — definição e entrada de cálculo dos seis KPIs de contas a pagar e recebíveis em 7, 30 e 60 dias. Os 15 campos do livro (M9-D603):
 * fonte rm_finance_health, fórmula versionada no código (formulas/_finWindow.js), dimensões, unidade, owner (parâmetro analytics.owner.<código>),
 * política de atualização (evento + agenda de 15 min, M9-D607) e regra de qualidade. Versão 1, natureza PREVISTA (PLANNED, M9-D610).
 * fin.payables_7d é CRITICAL (prazo crítico do bloco 5, tabela da M9-D712): nasce com drill-down.
 */
const { WINDOW_CODES } = require('../../read-models/financeWindow.settings');

const REFERENCE_REPORT = 'Relatório de contas a pagar e a receber do Financeiro (M9-D708): janelas de 7, 30 e 60 dias';
const MAX_STALENESS_MINUTES = 15;
const DIMENSIONS = Object.freeze({
  'fin.payables_7d': ['empresa', 'centro de custo', 'conta contábil'],
  'fin.payables_30d': ['empresa', 'centro de custo'],
  'fin.payables_60d': ['empresa', 'centro de custo'],
  'fin.receivables_7d': ['empresa', 'contrato', 'centro de resultado'],
  'fin.receivables_30d': ['empresa', 'contrato', 'centro de resultado'],
  'fin.receivables_60d': ['empresa', 'contrato', 'centro de resultado'],
});
const KIND = Object.freeze({
  payables: { name: 'Contas a pagar', what: 'saídas próprias', semantic: 'saídas (PAYABLE) próprias, PENDING' },
  receivables: { name: 'Recebíveis', what: 'entradas próprias', semantic: 'entradas (RECEIVABLE) próprias, PENDING' },
});

const parse = (code) => { const [, kind, days] = /^fin\.(payables|receivables)_(\d+)d$/.exec(code); return { kind, days: Number(days) }; };

const DEFINITIONS = Object.freeze(WINDOW_CODES.map((code) => {
  const { kind, days } = parse(code);
  return {
    metricCode: code, name: `${KIND[kind].name} em ${days} dias`, formulaId: code, valueNature: 'PLANNED', unit: 'BRL', dimensions: [...DIMENSIONS[code]],
    criticality: code === 'fin.payables_7d' ? 'CRITICAL' : 'NORMAL',
    description: `Soma, em reais, das ${KIND[kind].what} pendentes com vencimento de hoje até hoje+${days - 1} (janela cumulativa, dinheiro de terceiros fora; vencidos ficam em outro indicador).`,
    formulaSemantic: `Σ amount dos lançamentos de ${KIND[kind].semantic}, isThirdPartyFunds=false, estorno fora, com vencimento (calendário de São Paulo) entre hoje e hoje+${days - 1}, inclusive; valor previsto.`,
    qualityRule: { referenceReport: REFERENCE_REPORT, maxStalenessMinutes: MAX_STALENESS_MINUTES, requiredFields: [`${kind}_without_due_date`], allowNull: true },
  };
}));

/** Entrada da fórmula a partir da linha do rm_finance_health: o valor da janela e a contagem de lançamentos pendentes sem vencimento da natureza. */
const INPUTS = Object.freeze(Object.fromEntries(WINDOW_CODES.map((code) => {
  const { kind, days } = parse(code);
  return [code, (row, asOfDate) => ({ asOfDate, amount: String(row[`${kind}_${days}d`]), withoutDueDate: row[`${kind}_without_due_date`] })];
})));

module.exports = { DEFINITIONS, INPUTS };
