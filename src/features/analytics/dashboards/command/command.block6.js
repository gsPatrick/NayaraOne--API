'use strict';

/**
 * M9-D685 (3.1, bloco 6) — "Quais oportunidades merecem atenção": oportunidades em estágio avançado paradas há mais de `analytics.centro.opp_parada_dias` dias
 * (`crm.opportunities_by_stage`, que já aplica esse prazo), propostas em aberto e o valor delas (`crm.proposals`), matches do Radar ainda sem contato (`radar.matches`:
 * cruzamentos menos enviados) e imóveis na última faixa de dias sem venda (`prop.without_sale_by_period`), esta só com SUGESTÃO de ação, nunca decisão (M9-D693).
 * Ordem: o que tem mais itens primeiro.
 */
const money = require('../../metrics/formulas/money');
const { formatValue } = require('../dashboard.format');
const { dim, isPositive } = require('./command.read');
const { makeItem } = require('./command.item');

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const num = (text) => (isPositive(text) ? Number(text) : 0);
const SUGGESTION = 'Sugestão (apenas sugestão, quem decide é a equipe): rever o preço e os canais de divulgação.';

function stalledItem(env, src) {
  const n = num(dim(src, 'paradas_qtd'));
  if (!n) return [];
  return [makeItem({ type: 'OPORTUNIDADE_PARADA', title: `${plural(n, 'oportunidade em estágio avançado parada', 'oportunidades em estágio avançado paradas')} há mais de ${env.params.stalledDays} dias`, severity: 'WARNING', domain: src.domain, metricCode: 'crm.opportunities_by_stage', value: String(n), formatted: String(n), unit: 'COUNT', drilldown: true, sortValue: n })];
}

function proposalsItem(src) {
  const n = num(dim(src, 'em_aberto'));
  if (!n) return [];
  const total = dim(src, 'valor_total_brl');
  return [makeItem({ type: 'PROPOSTA_EM_ABERTO', title: plural(n, 'proposta em aberto', 'propostas em aberto'), detail: total ? `Valor total das propostas enviadas: ${formatValue('BRL', total)}.` : null, severity: 'INFO', domain: src.domain, metricCode: 'crm.proposals', value: String(n), formatted: String(n), unit: 'COUNT', drilldown: true, sortValue: n })];
}

function matchesItem(src) {
  const sent = dim(src, 'enviados');
  if (sent === null || !isPositive(src.value)) return [];
  const without = money.sub(src.value, sent);
  if (money.cmp(without, 0) <= 0) return [];
  const n = Number(money.toString(without));
  return [makeItem({ type: 'MATCH_SEM_CONTATO', title: plural(n, 'match do Radar sem contato', 'matches do Radar sem contato'), severity: 'INFO', domain: src.domain, metricCode: 'radar.matches', value: String(n), formatted: String(n), unit: 'COUNT', drilldown: true, sortValue: n })];
}

function noSaleItem(src) {
  const key = [...src.dims.keys()].find((k) => /^faixa:ACIMA_/.test(k)); // a última faixa é a lista de atenção
  const n = key ? num(src.dims.get(key)) : 0;
  if (!n) return [];
  const days = key.replace('faixa:ACIMA_', '');
  return [makeItem({ type: 'IMOVEL_SEM_VENDA', title: `${plural(n, 'imóvel', 'imóveis')} há mais de ${days} dias sem venda`, detail: SUGGESTION, severity: 'INFO', domain: src.domain, metricCode: 'prop.without_sale_by_period', value: String(n), formatted: String(n), unit: 'COUNT', drilldown: true, sortValue: n, extra: { suggestionOnly: true } })];
}

async function buildOportunidades(env) {
  const builders = [['crm.opportunities_by_stage', (s) => stalledItem(env, s)], ['crm.proposals', proposalsItem], ['radar.matches', matchesItem], ['prop.without_sale_by_period', noSaleItem]];
  return builders.flatMap(([code, build]) => { const src = env.sources.get(code); return src && src.ok ? build(src) : []; });
}

module.exports = { buildOportunidades };
