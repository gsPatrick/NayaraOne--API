'use strict';

/**
 * M9-D685 (3.1, bloco 5) — "Quais prazos estão críticos". Só os tipos do mapa 3.2-A: prazos jurídicos vencidos e dos próximos 7 dias (`legal.deadlines`), garantias a
 * vencer em 30 dias (`rent.guarantees_expiring`), contas a pagar dos próximos 7 dias (`fin.payables_7d`), atrasos de obra (`obra.delays`) e vistorias e chaves atrasadas
 * (`rent.inspections_keys`). Ordem: vencidos primeiro (faixa 0, o mais antigo antes) e, depois, por proximidade (faixa 1: até 7 dias; faixa 2: até 30 dias).
 */
const { formatValue } = require('../dashboard.format');
const { dim, isPositive } = require('./command.read');
const { makeItem } = require('./command.item');

const OVERDUE = 0;
const NEXT_7_DAYS = 1;
const NEXT_30_DAYS = 2;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const num = (src, key) => (isPositive(dim(src, key)) ? Number(dim(src, key)) : 0);

function legalItems(src) {
  const items = [];
  const overdue = num(src, 'vencidos_qtd');
  if (overdue > 0) {
    const oldest = num(src, 'mais_antigo_vencido_dias');
    items.push(makeItem({ type: 'PRAZO_JURIDICO', idSuffix: 'vencidos', title: plural(overdue, 'prazo jurídico vencido', 'prazos jurídicos vencidos'), detail: oldest ? `O mais antigo venceu há ${oldest} dias.` : null, severity: 'CRITICAL', domain: src.domain, metricCode: 'legal.deadlines', value: String(overdue), formatted: String(overdue), unit: 'COUNT', drilldown: true, rank: OVERDUE, sortValue: oldest }));
  }
  const next = num(src, 'proximos_7d_qtd');
  if (next > 0) items.push(makeItem({ type: 'PRAZO_JURIDICO', idSuffix: 'proximos_7d', title: plural(next, 'prazo jurídico nos próximos 7 dias', 'prazos jurídicos nos próximos 7 dias'), severity: 'WARNING', domain: src.domain, metricCode: 'legal.deadlines', value: String(next), formatted: String(next), unit: 'COUNT', drilldown: true, rank: NEXT_7_DAYS, sortValue: next }));
  return items;
}

function obraDelayItems(src) {
  const items = [];
  for (const [key, value] of src.dims) {
    const m = /^obra:([^:]+)$/.exec(key);
    if (!m || !isPositive(value)) continue;
    const days = num(src, `obra:${m[1]}:maximo_dias`);
    items.push(makeItem({ type: 'ATRASO_OBRA', idSuffix: m[1], title: `Obra ${m[1].slice(0, 8)}: ${plural(Number(value), 'etapa atrasada', 'etapas atrasadas')}`, detail: days ? `Maior atraso: ${days} dias.` : null, severity: 'CRITICAL', domain: src.domain, metricCode: 'obra.delays', value, formatted: String(Number(value)), unit: 'COUNT', drilldown: true, rank: OVERDUE, sortValue: days, extra: { projectId: m[1] } }));
  }
  return items;
}

function metricItems(env) {
  const get = (code) => env.sources.get(code);
  const items = [];
  const legal = get('legal.deadlines');
  if (legal && legal.ok) items.push(...legalItems(legal));
  const guarantees = get('rent.guarantees_expiring');
  if (guarantees && guarantees.ok && num(guarantees, 'vencendo_30d_qtd') > 0) {
    const n = num(guarantees, 'vencendo_30d_qtd');
    items.push(makeItem({ type: 'GARANTIA_A_VENCER', idSuffix: 'vencendo_30d', title: plural(n, 'garantia de locação vence em até 30 dias', 'garantias de locação vencem em até 30 dias'), severity: 'WARNING', domain: guarantees.domain, metricCode: 'rent.guarantees_expiring', value: String(n), formatted: String(n), unit: 'COUNT', drilldown: true, rank: NEXT_30_DAYS, sortValue: n }));
  }
  const payables = get('fin.payables_7d');
  if (payables && payables.ok && isPositive(payables.value)) {
    items.push(makeItem({ type: 'CONTAS_A_PAGAR', title: `Contas a pagar nos próximos 7 dias: ${formatValue('BRL', payables.value)}`, severity: 'INFO', domain: payables.domain, metricCode: 'fin.payables_7d', value: payables.value, formatted: formatValue('BRL', payables.value), unit: 'BRL', drilldown: true, rank: NEXT_7_DAYS, sortValue: Number(payables.value) }));
  }
  const delays = get('obra.delays');
  if (delays && delays.ok) items.push(...obraDelayItems(delays));
  const keys = get('rent.inspections_keys');
  if (keys && keys.ok) {
    for (const [key, one, many] of [['vistorias_atrasadas_qtd', 'vistoria atrasada', 'vistorias atrasadas'], ['chaves_atrasadas_qtd', 'chave com devolução atrasada', 'chaves com devolução atrasada']]) {
      const n = num(keys, key);
      if (n > 0) items.push(makeItem({ type: 'VISTORIA_CHAVE_ATRASADA', idSuffix: key, title: plural(n, one, many), severity: 'WARNING', domain: keys.domain, metricCode: 'rent.inspections_keys', value: String(n), formatted: String(n), unit: 'COUNT', drilldown: true, rank: OVERDUE, sortValue: n }));
    }
  }
  return items;
}

async function buildPrazos(env) {
  return metricItems(env).map((item) => ({ ...item, overdue: item.sort.rank === OVERDUE })); // `overdue`: o Front destaca o prazo já vencido
}

module.exports = { buildPrazos, OVERDUE, NEXT_7_DAYS, NEXT_30_DAYS };
