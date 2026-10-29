'use strict';

/**
 * M9-D661 — KPI cor.approval_rate_by_provider (Aprovação e rejeição por provider), versão 1. Por provider, no mês de São Paulo da data-base:
 * aprovadas, rejeitadas e taxa de aprovação = aprovadas ÷ (aprovadas + rejeitadas) × 100, 2 casas (pendentes não entram). O valor é o total de
 * decisões do mês. Provider com menos de minSample decisões (analytics.qualidade.min_amostra) fica INCOMPLETE sem taxa; sem nenhum provider com amostra
 * suficiente o KPI todo sai INCOMPLETE, valor nulo. Entrada (rm_fin_provider_outcome): { rows: [{ provider, product, approved, rejected }] }.
 */
const money = require('./money');
const { incomplete, sumCounts, byText } = require('./_legalCorKpi');

function compute(input, params = {}) {
  const minSample = Number.isInteger(params.minSample) && params.minSample >= 1 ? params.minSample : 5;
  const providers = [...new Set((input.rows || []).map((r) => r.provider))].sort(byText).map((provider) => {
    const own = input.rows.filter((r) => r.provider === provider);
    const approved = sumCounts(own.map((r) => r.approved));
    const rejected = sumCounts(own.map((r) => r.rejected));
    const decisions = money.count(money.add(approved, rejected));
    const enough = money.cmp(decisions, minSample) >= 0;
    return { provider, approved, rejected, decisions, status: enough ? 'OK' : 'INCOMPLETE', rate: enough ? money.percent(approved, decisions).value : null };
  });
  const approved = sumCounts(providers.map((p) => p.approved));
  const rejected = sumCounts(providers.map((p) => p.rejected));
  const decisions = money.count(money.add(approved, rejected));
  const details = { decisions, approved, rejected, minSample: String(minSample), byProvider: providers };
  if (!providers.some((p) => p.status === 'OK')) return incomplete('AMOSTRA_INSUFICIENTE', details);
  const dimensions = [{ key: 'aprovadas_qtd', value: approved }, { key: 'rejeitadas_qtd', value: rejected }, { key: 'taxa_pct', value: money.percent(approved, decisions).value }];
  for (const p of providers) {
    dimensions.push({ key: `provider:${p.provider}:aprovadas_qtd`, value: p.approved }, { key: `provider:${p.provider}:rejeitadas_qtd`, value: p.rejected });
    if (p.rate !== null) dimensions.push({ key: `provider:${p.provider}:taxa_pct`, value: p.rate });
  }
  return { value: decisions, status: 'OK', details, dimensions };
}

const row = (provider, approved, rejected, product = 'FINANCIAMENTO') => ({ provider, product, approved, rejected });
const p = (provider, approved, rejected, decisions, status, rate) => ({ provider, approved, rejected, decisions, status, rate });
const dimsOf = (approved, rejected, rate, list) => [
  { key: 'aprovadas_qtd', value: approved }, { key: 'rejeitadas_qtd', value: rejected }, { key: 'taxa_pct', value: rate },
  ...list.flatMap((x) => [{ key: `provider:${x.provider}:aprovadas_qtd`, value: x.approved }, { key: `provider:${x.provider}:rejeitadas_qtd`, value: x.rejected }, ...(x.rate === null ? [] : [{ key: `provider:${x.provider}:taxa_pct`, value: x.rate }])]),
];
const okOf = (decisions, approved, rejected, rate, list, minSample = '5') => ({ value: decisions, status: 'OK', details: { decisions, approved, rejected, minSample, byProvider: list }, dimensions: dimsOf(approved, rejected, rate, list) });
const noSample = (decisions, approved, rejected, list, minSample = '5') => ({ value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'AMOSTRA_INSUFICIENTE', decisions, approved, rejected, minSample, byProvider: list }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhuma decisão no mês: INCOMPLETE e sem valor', input: { rows: [] }, expected: noSample('0', '0', '0', []) },
  { kind: 'single', name: 'um provider com 5 decisões (amostra mínima): 100,00%', input: { rows: [row('BANCO_A', 5, 0)] }, expected: okOf('5', '5', '0', '100.00', [p('BANCO_A', '5', '0', '5', 'OK', '100.00')]) },
  {
    kind: 'typical', name: 'exemplo da demanda: Banco A com 18 aprovadas e 7 rejeitadas = 72,00%; produtos do mesmo provider se somam', input: { rows: [row('BANCO_A', 10, 3), row('BANCO_A', 8, 4, 'CONSORCIO')] },
    expected: okOf('25', '18', '7', '72.00', [p('BANCO_A', '18', '7', '25', 'OK', '72.00')]),
  },
  {
    kind: 'period_edge', name: 'provider com 4 decisões fica INCOMPLETE sem taxa, mas o outro com amostra mantém o KPI', input: { rows: [row('BANCO_A', 4, 0), row('BANCO_B', 3, 3)] },
    expected: okOf('10', '7', '3', '70.00', [p('BANCO_A', '4', '0', '4', 'INCOMPLETE', null), p('BANCO_B', '3', '3', '6', 'OK', '50.00')]),
  },
  { kind: 'rounding', name: 'taxa com dízima arredonda uma vez: 1 de 3 = 33,33% (amostra mínima 3)', params: { minSample: 3 }, input: { rows: [row('BANCO_A', 1, 2)] }, expected: okOf('3', '1', '2', '33.33', [p('BANCO_A', '1', '2', '3', 'OK', '33.33')], '3') },
  { kind: 'period_edge', name: 'todos os providers abaixo da amostra: KPI INCOMPLETE', input: { rows: [row('BANCO_A', 2, 1)] }, expected: noSample('3', '2', '1', [p('BANCO_A', '2', '1', '3', 'INCOMPLETE', null)]) },
];

module.exports = { id: 'cor.approval_rate_by_provider', version: 1, compute, testCases };
