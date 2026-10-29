'use strict';

/**
 * M9-D661 — KPI cor.commission (Comissão esperada, confirmada e recebida), versão 1. Posição no fim do dia-base com TRÊS séries separadas que nunca
 * se somam (M9-D610): esperada (ESTIMATED), que é o valor do indicador; confirmada (PLANNED, após a aprovação) e recebida (ACTUAL, lançamento
 * liquidado). A diferença confirmada − recebida é o "a receber" (a_receber_brl). Entrada (rm_fin_commission): { rows: [{ provider, expected, confirmed,
 * received, receivedUnlinked }] }. Regra de qualidade: comissão recebida sem caso ou sem lançamento liquidado vinculado -> DEGRADED, valor nulo;
 * campo ainda não calculado pelo read model (nulo) também. Dinheiro em decimal exato, arredondado uma só vez.
 */
const money = require('./money');
const { degraded, sumCounts, byText } = require('./_legalCorKpi');

function compute(input) {
  const rows = input.rows || [];
  if (rows.some((r) => r.receivedUnlinked === null || r.receivedUnlinked === undefined)) return degraded('READ_MODEL_NAO_RECALCULADO', {});
  const unlinked = sumCounts(rows.map((r) => r.receivedUnlinked));
  if (money.cmp(unlinked, 0) > 0) return degraded('RECEBIDA_SEM_CASO_VINCULADO', { receivedUnlinked: unlinked });
  const total = (field) => money.money(money.sum(rows.map((r) => r[field] || 0)));
  const [expected, confirmed, received] = [total('expected'), total('confirmed'), total('received')];
  const toReceive = money.money(money.sub(confirmed, received));
  const dimensions = [{ key: 'confirmada_brl', value: confirmed }, { key: 'recebida_brl', value: received }, { key: 'a_receber_brl', value: toReceive }];
  for (const provider of [...new Set(rows.map((r) => r.provider))].sort(byText)) {
    const own = rows.filter((r) => r.provider === provider);
    const sum = (field) => money.money(money.sum(own.map((r) => r[field] || 0)));
    dimensions.push(
      { key: `provider:${provider}:esperada_brl`, value: sum('expected') }, { key: `provider:${provider}:confirmada_brl`, value: sum('confirmed') },
      { key: `provider:${provider}:recebida_brl`, value: sum('received') }
    );
  }
  const series = [
    { valueNature: 'ACTUAL', label: 'Realizado', points: [{ key: 'recebida', value: received }], total: received },
    { valueNature: 'PLANNED', label: 'Previsto', points: [{ key: 'confirmada', value: confirmed }], total: confirmed },
    { valueNature: 'ESTIMATED', label: 'Estimado', points: [{ key: 'esperada', value: expected }], total: expected },
  ];
  return { value: expected, status: 'OK', details: { toReceive, series }, dimensions };
}

const row = (provider, expected, confirmed, received, receivedUnlinked = 0) => ({ provider, expected, confirmed, received, receivedUnlinked });
const okOf = (e, c, r, toReceive, providers) => ({
  value: e, status: 'OK',
  details: {
    toReceive,
    series: [
      { valueNature: 'ACTUAL', label: 'Realizado', points: [{ key: 'recebida', value: r }], total: r },
      { valueNature: 'PLANNED', label: 'Previsto', points: [{ key: 'confirmada', value: c }], total: c },
      { valueNature: 'ESTIMATED', label: 'Estimado', points: [{ key: 'esperada', value: e }], total: e },
    ],
  },
  dimensions: [{ key: 'confirmada_brl', value: c }, { key: 'recebida_brl', value: r }, { key: 'a_receber_brl', value: toReceive },
    ...providers.flatMap(([p, pe, pc, pr]) => [{ key: `provider:${p}:esperada_brl`, value: pe }, { key: `provider:${p}:confirmada_brl`, value: pc }, { key: `provider:${p}:recebida_brl`, value: pr }])],
});
const bad = (reason, details = {}) => ({ value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason, ...details }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhuma comissão: zero nas três séries, não nulo', input: { rows: [] }, expected: okOf('0.00', '0.00', '0.00', '0.00', []) },
  { kind: 'single', name: 'um provider só com comissão esperada', input: { rows: [row('BANCO_A', '1000.50', '0', '0')] }, expected: okOf('1000.50', '0.00', '0.00', '0.00', [['BANCO_A', '1000.50', '0.00', '0.00']]) },
  {
    kind: 'typical', name: 'exemplo da demanda: esperada 96.000,00; confirmada 54.000,00; recebida 31.000,00; a receber 23.000,00',
    input: { rows: [row('BANCO_A', '60000.00', '34000.00', '20000.00'), row('BANCO_B', '36000.00', '20000.00', '11000.00')] },
    expected: okOf('96000.00', '54000.00', '31000.00', '23000.00', [['BANCO_A', '60000.00', '34000.00', '20000.00'], ['BANCO_B', '36000.00', '20000.00', '11000.00']]),
  },
  { kind: 'period_edge', name: 'tudo recebido: a receber zero', input: { rows: [row('BANCO_A', '0', '500.00', '500.00')] }, expected: okOf('0.00', '500.00', '500.00', '0.00', [['BANCO_A', '0.00', '500.00', '500.00']]) },
  { kind: 'rounding', name: 'centavos somam exatos: 0,10 + 0,20 = 0,30', input: { rows: [row('A', '0.10', '0.10', '0'), row('B', '0.20', '0.20', '0')] }, expected: okOf('0.30', '0.30', '0.00', '0.30', [['A', '0.10', '0.10', '0.00'], ['B', '0.20', '0.20', '0.00']]) },
  { kind: 'period_edge', name: 'comissão recebida sem caso vinculado: DEGRADED e sem valor', input: { rows: [row('BANCO_A', '10', '10', '10', 1)] }, expected: bad('RECEBIDA_SEM_CASO_VINCULADO', { receivedUnlinked: '1' }) },
  { kind: 'period_edge', name: 'campo ainda não calculado pelo read model: DEGRADED', input: { rows: [row('BANCO_A', '10', '10', '10', null)] }, expected: bad('READ_MODEL_NAO_RECALCULADO') },
];

module.exports = { id: 'cor.commission', version: 1, compute, testCases };
