'use strict';

/**
 * M9-D620 — KPI fin.free_cash (Caixa livre por empresa), versão 1. Posição no fim do dia-base, em reais com 2 casas, arredondada uma vez:
 *   caixaTotal       = lançamentos liquidados (próprios e de terceiros, receber menos pagar) + transferências entre empresas liquidadas + saldo de abertura (se ligado)
 *   terceirosRetidos = dinheiro de terceiros recebido e ainda não liberado (devolução ou compensação)
 *   freeCash         = caixaTotal - terceirosRetidos      (pode ser negativo: o sinal é mostrado, nunca truncado em zero)
 * Defesa da regra "não misturar caixa próprio e de terceiros" (BI-005): a entrada traz o filtro que o read model aplicou à parte própria do ledger
 * (`ledgerFilter.is_third_party_funds`); se não for exatamente `false`, o KPI não sai (DEGRADED, valor nulo).
 * Entrada (linha do rm_finance_health): { asOfDate, ledgerFilter, totalCash, thirdPartyRetained, openingBalance, includeOpening, intercompanyNet, byAccount:
 * { conta: { ledger, opening } }, byCostCenter: { centro: valor }, manualReviewPending, reconciliationGap, reconciliationAccounts }; params: { tolerance }.
 * Regra de qualidade: lançamento em revisão manual pendente, ou caixa do ledger diferente do saldo da última conciliação bancária conciliada em mais
 * que a tolerância, deixa o KPI DEGRADED com valor nulo (nunca um número enganoso).
 */
const money = require('./money');
const { degraded } = require('./_finKpi');

const ZERO = '0.00';
const sumOf = (list) => money.money(money.toString(money.sum(list)));
const minus = (a, b) => money.money(money.toString(money.sub(a, b)));

function qualityReasons(input, tolerance) {
  const reasons = [];
  if (money.count(input.manualReviewPending || 0) !== '0') reasons.push('LANCAMENTO_EM_REVISAO_MANUAL');
  const gap = input.reconciliationGap;
  if (gap !== null && gap !== undefined && money.cmp(String(gap), String(tolerance || '0.01')) > 0) reasons.push('CAIXA_DIVERGE_DA_CONCILIACAO');
  return reasons;
}

function dimensions(input, opening) {
  const dims = [];
  for (const account of Object.keys(input.byAccount || {}).sort()) {
    const part = input.byAccount[account];
    dims.push({ key: `conta:${account}`, value: sumOf([part.ledger, input.includeOpening ? part.opening : ZERO]) });
  }
  const centers = { ...(input.byCostCenter || {}) };
  centers.sem_centro = sumOf([centers.sem_centro || ZERO, input.intercompanyNet || ZERO, opening]);
  for (const center of Object.keys(centers).sort()) dims.push({ key: `centro_custo:${center}`, value: sumOf([centers[center]]) });
  return dims;
}

function compute(input, params = {}) {
  if (!(input.ledgerFilter && input.ledgerFilter.is_third_party_funds === false)) return degraded('FILTRO_DE_TERCEIROS_AUSENTE', { reasons: ['FILTRO_DE_TERCEIROS_AUSENTE'] });
  const reasons = qualityReasons(input, params.tolerance);
  if (reasons.length) {
    return degraded(reasons[0], {
      reasons, pendingManualReview: money.count(input.manualReviewPending || 0), reconciliationGap: input.reconciliationGap ?? null,
      tolerance: params.tolerance || '0.01', reconciliationAccounts: money.count(input.reconciliationAccounts || 0),
    });
  }
  const opening = input.includeOpening ? sumOf([input.openingBalance || ZERO]) : ZERO;
  const totalCash = sumOf([input.totalCash]);
  const retained = sumOf([input.thirdPartyRetained]);
  const value = minus(totalCash, retained);
  return {
    value, status: 'OK',
    details: { totalCash, thirdPartyRetained: retained, openingBalance: opening, includeOpening: Boolean(input.includeOpening), intercompanyNet: sumOf([input.intercompanyNet || ZERO]) },
    dimensions: dimensions(input, opening),
  };
}

const base = (extra = {}) => ({
  asOfDate: '2026-10-28', ledgerFilter: { is_third_party_funds: false }, totalCash: '125000.00', thirdPartyRetained: '35000.00', openingBalance: '10000.00', includeOpening: true, intercompanyNet: '0.00',
  byAccount: {}, byCostCenter: {}, manualReviewPending: 0, reconciliationGap: null, reconciliationAccounts: 0, ...extra,
});
const okDetails = (total, retained, opening, includeOpening, legs = '0.00') => ({ totalCash: total, thirdPartyRetained: retained, openingBalance: opening, includeOpening, intercompanyNet: legs });

const testCases = [
  {
    kind: 'empty', name: 'empresa sem lançamentos nem conta: caixa livre zero', params: { tolerance: '0.01' },
    input: base({ totalCash: '0.00', thirdPartyRetained: '0.00', openingBalance: '0.00' }),
    expected: { value: '0.00', status: 'OK', details: okDetails('0.00', '0.00', '0.00', true), dimensions: [{ key: 'centro_custo:sem_centro', value: '0.00' }] },
  },
  {
    kind: 'single', name: 'um lançamento próprio liquidado de 100,00', params: { tolerance: '0.01' },
    input: base({ totalCash: '100.00', thirdPartyRetained: '0.00', openingBalance: '0.00', byAccount: { c1: { ledger: '100.00', opening: '0.00' } }, byCostCenter: { cc1: '100.00' } }),
    expected: {
      value: '100.00', status: 'OK', details: okDetails('100.00', '0.00', '0.00', true),
      dimensions: [{ key: 'conta:c1', value: '100.00' }, { key: 'centro_custo:cc1', value: '100.00' }, { key: 'centro_custo:sem_centro', value: '0.00' }],
    },
  },
  {
    kind: 'typical', name: 'exemplo da demanda: abertura 10.000, próprias 100.000, terceiros 35.000, saídas 20.000 => caixa total 125.000 e livre 90.000', params: { tolerance: '0.01' },
    input: base({ byAccount: { c1: { ledger: '80000.00', opening: '10000.00' } }, byCostCenter: { cc1: '80000.00' } }),
    expected: {
      value: '90000.00', status: 'OK', details: okDetails('125000.00', '35000.00', '10000.00', true),
      dimensions: [{ key: 'conta:c1', value: '90000.00' }, { key: 'centro_custo:cc1', value: '80000.00' }, { key: 'centro_custo:sem_centro', value: '10000.00' }],
    },
  },
  {
    kind: 'period_edge', name: 'caixa negativo é mostrado negativo (nunca truncado em zero) e a tolerância da conciliação é inclusiva', params: { tolerance: '0.01' },
    input: base({ totalCash: '1000.00', thirdPartyRetained: '1500.50', openingBalance: '0.00', reconciliationGap: '0.01', reconciliationAccounts: 1 }),
    expected: { value: '-500.50', status: 'OK', details: okDetails('1000.00', '1500.50', '0.00', true), dimensions: [{ key: 'centro_custo:sem_centro', value: '0.00' }] },
  },
  {
    kind: 'period_edge', name: 'divergência com a conciliação acima da tolerância: DEGRADED, sem valor', params: { tolerance: '0.01' },
    input: base({ reconciliationGap: '0.02', reconciliationAccounts: 2 }),
    expected: {
      value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', dimensions: [],
      details: { reason: 'CAIXA_DIVERGE_DA_CONCILIACAO', reasons: ['CAIXA_DIVERGE_DA_CONCILIACAO'], pendingManualReview: '0', reconciliationGap: '0.02', tolerance: '0.01', reconciliationAccounts: '2' },
    },
  },
  {
    kind: 'period_edge', name: 'lançamento em revisão manual pendente: DEGRADED, sem valor', params: { tolerance: '0.01' },
    input: base({ manualReviewPending: 1 }),
    expected: {
      value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', dimensions: [],
      details: { reason: 'LANCAMENTO_EM_REVISAO_MANUAL', reasons: ['LANCAMENTO_EM_REVISAO_MANUAL'], pendingManualReview: '1', reconciliationGap: null, tolerance: '0.01', reconciliationAccounts: '0' },
    },
  },
  {
    kind: 'period_edge', name: 'leitura do caixa sem o filtro de terceiros do read model: o KPI não sai (nunca mistura caixa próprio e de terceiros)', params: { tolerance: '0.01' },
    input: base({ ledgerFilter: { is_third_party_funds: null } }),
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'FILTRO_DE_TERCEIROS_AUSENTE', reasons: ['FILTRO_DE_TERCEIROS_AUSENTE'] }, dimensions: [] },
  },
  {
    kind: 'rounding', name: 'centavos exatos e arredondamento uma vez só (meio para cima)', params: { tolerance: '0.01' },
    input: base({ totalCash: '0.10', thirdPartyRetained: '0.0749', openingBalance: '0.00', includeOpening: false, intercompanyNet: '-0.10' }),
    expected: { value: '0.03', status: 'OK', details: okDetails('0.10', '0.07', '0.00', false, '-0.10'), dimensions: [{ key: 'centro_custo:sem_centro', value: '-0.10' }] },
  },
];

module.exports = { id: 'fin.free_cash', version: 1, compute, testCases };
