'use strict';

/**
 * M9-D671 — KPI mkt.opt_out (Opt-out), versão 1. Fluxo no mês de São Paulo da data-base: taxa de opt-out = pedidos de saída ÷ contatos alcançados × 100
 * (2 casas), com a contagem absoluta em `saidas_qtd`; por canal. Nenhum contato alcançado = INCOMPLETE; pedido de saída sem data (regra de qualidade) deixa o
 * KPI DEGRADED; ambos sem valor. Entrada (rm_mkt_optout_month do mês): { rows: [{ channel, reached, optOuts, undated }] }.
 */
const money = require('./money');
const { sumCounts, groupSum, pct, degraded, incomplete } = require('./_mktKpi');

function compute(input) {
  const rows = input.rows || [];
  const reached = sumCounts(rows.map((r) => r.reached));
  const optOuts = sumCounts(rows.map((r) => r.optOuts));
  const undated = sumCounts(rows.map((r) => r.undated));
  const details = { reached, optOuts };
  if (money.cmp(undated, 0) > 0) return degraded('OPT_OUT_SEM_DATA', { ...details, undated });
  if (money.cmp(reached, 0) === 0) return incomplete('SEM_CONTATO_ALCANCADO', details);
  const byChannel = groupSum(rows, (r) => r.channel, ['reached', 'optOuts']).map(([channel, v]) => ({ channel, reached: v.reached, optOuts: v.optOuts, rate: pct(v.optOuts, v.reached) }));
  const dimensions = [{ key: 'saidas_qtd', value: optOuts }, { key: 'alcancados_qtd', value: reached }];
  for (const c of byChannel) if (c.rate !== null) dimensions.push({ key: `canal:${c.channel}:taxa_pct`, value: c.rate }, { key: `canal:${c.channel}:saidas_qtd`, value: c.optOuts });
  return { value: pct(optOuts, reached), status: 'OK', details: { ...details, byChannel }, dimensions };
}

const row = (channel, reached, optOuts, undated = 0) => ({ channel, reached, optOuts, undated });
const okOf = (value, reached, optOuts, byChannel) => ({
  value, status: 'OK', details: { reached, optOuts, byChannel },
  dimensions: [{ key: 'saidas_qtd', value: optOuts }, { key: 'alcancados_qtd', value: reached }, ...byChannel.flatMap((c) => [{ key: `canal:${c.channel}:taxa_pct`, value: c.rate }, { key: `canal:${c.channel}:saidas_qtd`, value: c.optOuts }])],
});
const ch = (channel, reached, optOuts, rate) => ({ channel, reached, optOuts, rate });
const bad = (status, reason, details) => ({ value: null, status, message: 'Dado incompleto, valor não confiável.', details: { reason, ...details }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhum contato alcançado no mês: INCOMPLETE e sem valor', input: { rows: [] }, expected: bad('INCOMPLETE', 'SEM_CONTATO_ALCANCADO', { reached: '0', optOuts: '0' }) },
  { kind: 'single', name: 'um contato alcançado e nenhuma saída: 0,00%', input: { rows: [row('EMAIL', 1, 0)] }, expected: okOf('0.00', '1', '0', [ch('EMAIL', '1', '0', '0.00')]) },
  {
    kind: 'typical', name: 'exemplo da demanda: 24 saídas ÷ 2.000 alcançados = 1,20%; por canal',
    input: { rows: [row('WHATSAPP', 1500, 20), row('EMAIL', 500, 4)] }, expected: okOf('1.20', '2000', '24', [ch('EMAIL', '500', '4', '0.80'), ch('WHATSAPP', '1500', '20', '1.33')]),
  },
  { kind: 'period_edge', name: 'canal que só tem saída e nenhum alcançado fica de fora das taxas por canal, mas entra na contagem absoluta', input: { rows: [row('WHATSAPP', 100, 1), row('PHONE', 0, 2)] }, expected: { value: '3.00', status: 'OK', details: { reached: '100', optOuts: '3', byChannel: [ch('PHONE', '0', '2', null), ch('WHATSAPP', '100', '1', '1.00')] }, dimensions: [{ key: 'saidas_qtd', value: '3' }, { key: 'alcancados_qtd', value: '100' }, { key: 'canal:WHATSAPP:taxa_pct', value: '1.00' }, { key: 'canal:WHATSAPP:saidas_qtd', value: '1' }] } },
  { kind: 'rounding', name: 'taxa arredonda uma vez: 1 de 3 = 33,33%; 1 de 8 = 12,50%', input: { rows: [row('SITE', 3, 1)] }, expected: okOf('33.33', '3', '1', [ch('SITE', '3', '1', '33.33')]) },
  { kind: 'period_edge', name: 'pedido de saída sem data: DEGRADED e sem valor', input: { rows: [row('EMAIL', 100, 1, 2)] }, expected: bad('DEGRADED', 'OPT_OUT_SEM_DATA', { reached: '100', optOuts: '1', undated: '2' }) },
];

module.exports = { id: 'mkt.opt_out', version: 1, compute, testCases };
