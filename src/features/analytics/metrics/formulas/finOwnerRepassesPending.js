'use strict';

/**
 * M9-D623 — KPI fin.owner_repasses_pending (Repasses pendentes ao proprietário), versão 1. Posição no fim do dia-base: Σ do valor líquido dos repasses
 * gerados e ainda não pagos (PENDING ou APPROVED), a quantidade e a idade média em dias corridos; é dinheiro de terceiros e não reduz o caixa livre.
 * Entrada (rm_finance_health): { asOfDate, total, count, byOwner: { proprietário: valor }, byProperty: { imóvel: valor }, byAge: [{ count, amount,
 * calendarDays, businessDays }] } (a idade já vem calculada: dias corridos para a média, dias úteis do helper do projeto para o alerta e as faixas).
 * Parâmetros: alertBusinessDays (analytics.repasse.dias_alerta, padrão 5) e bands (analytics.repasse.faixas_atraso_dias, padrão 5,15).
 * Regra de qualidade: o repasse com mais de alertBusinessDays dias úteis é EXPOSTO em details.overdueBeyondAlert e nas dimensões `vencidos_alerta_*`
 * (o Centro de Comando o destaca), sem alerta próprio; o indicador continua OK (DI-D623-6). Dinheiro em decimal exato, arredondado uma só vez.
 */
const money = require('./money');

const keys = (map) => Object.keys(map || {}).sort();

function bandOf(days, [a, b]) {
  if (days <= a) return `0-${a}`;
  return days <= b ? `${a + 1}-${b}` : `${b + 1}+`;
}

function compute(input, params = {}) {
  const alert = Number.isInteger(params.alertBusinessDays) ? params.alertBusinessDays : 5;
  const edges = Array.isArray(params.bands) && params.bands.length === 2 ? params.bands : [5, 15];
  const ages = input.byAge || [];
  const labels = [`0-${edges[0]}`, `${edges[0] + 1}-${edges[1]}`, `${edges[1] + 1}+`];
  const bands = Object.fromEntries(labels.map((l) => [l, '0']));
  for (const row of ages) {
    const label = bandOf(row.businessDays, edges);
    bands[label] = money.toString(money.add(bands[label], row.amount));
  }
  const overdue = ages.filter((row) => row.businessDays > alert);
  const overdueBeyondAlert = { count: money.count(money.sum(overdue.map((row) => row.count))), amount: money.money(money.sum(overdue.map((row) => row.amount))) };
  const count = money.count(input.count);
  const avgAgeDays = count === '0' ? null : money.round(money.div(money.sum(ages.map((row) => money.mul(row.calendarDays, row.count))), count), 2);
  const dimensions = [
    ...keys(input.byOwner).map((k) => ({ key: `proprietario:${k}`, value: money.money(input.byOwner[k]) })),
    ...keys(input.byProperty).map((k) => ({ key: `imovel:${k}`, value: money.money(input.byProperty[k]) })),
    ...labels.map((l) => ({ key: `faixa:${l}`, value: money.money(bands[l]) })),
    { key: 'quantidade_qtd', value: count },
  ];
  if (avgAgeDays !== null) dimensions.push({ key: 'idade_media_dias', value: avgAgeDays });
  dimensions.push({ key: 'vencidos_alerta_brl', value: overdueBeyondAlert.amount }, { key: 'vencidos_alerta_qtd', value: overdueBeyondAlert.count });
  return { value: money.money(input.total), status: 'OK', details: { count, avgAgeDays, alertBusinessDays: String(alert), overdueBeyondAlert }, dimensions };
}

const input = (extra = {}) => ({
  asOfDate: '2026-10-28', total: '54000.00', count: 2, byOwner: { 'dono-1': '54000.00' }, byProperty: { 'imovel-1': '40000.00', 'imovel-2': '14000.00' },
  byAge: [{ count: 1, amount: '40000.00', calendarDays: 14, businessDays: 10 }, { count: 1, amount: '14000.00', calendarDays: 2, businessDays: 2 }], ...extra,
});
const tail = (qtd, avg, ovBrl, ovQtd) => [{ key: 'quantidade_qtd', value: qtd }, ...(avg === null ? [] : [{ key: 'idade_media_dias', value: avg }]), { key: 'vencidos_alerta_brl', value: ovBrl }, { key: 'vencidos_alerta_qtd', value: ovQtd }];
const bandDims = (a, b, c, edges = [5, 15]) => [{ key: `faixa:0-${edges[0]}`, value: a }, { key: `faixa:${edges[0] + 1}-${edges[1]}`, value: b }, { key: `faixa:${edges[1] + 1}+`, value: c }];
const okOf = (value, details, dimensions) => ({ value, status: 'OK', details, dimensions });
const detailsOf = (count, avgAgeDays, alert, ovCount, ovAmount) => ({ count, avgAgeDays, alertBusinessDays: alert, overdueBeyondAlert: { count: ovCount, amount: ovAmount } });

const testCases = [
  { kind: 'empty', name: 'nenhum repasse pendente: zero, sem idade média', input: input({ total: '0', count: 0, byOwner: {}, byProperty: {}, byAge: [] }), expected: okOf('0.00', detailsOf('0', null, '5', '0', '0.00'), [...bandDims('0.00', '0.00', '0.00'), ...tail('0', null, '0.00', '0')]) },
  {
    kind: 'single', name: 'um repasse de 2 dias úteis está dentro do alerta', input: input({ total: '900.00', count: 1, byOwner: { d1: '900.00' }, byProperty: { i1: '900.00' }, byAge: [{ count: 1, amount: '900.00', calendarDays: 2, businessDays: 2 }] }),
    expected: okOf('900.00', detailsOf('1', '2.00', '5', '0', '0.00'), [{ key: 'proprietario:d1', value: '900.00' }, { key: 'imovel:i1', value: '900.00' }, ...bandDims('900.00', '0.00', '0.00'), ...tail('1', '2.00', '0.00', '0')]),
  },
  {
    kind: 'typical', name: 'exemplo do livro: aluguéis a repassar 54.000,00; o de 10 dias úteis passa do alerta de 5 e continua OK', input: input(),
    expected: okOf('54000.00', detailsOf('2', '8.00', '5', '1', '40000.00'), [
      { key: 'proprietario:dono-1', value: '54000.00' }, { key: 'imovel:imovel-1', value: '40000.00' }, { key: 'imovel:imovel-2', value: '14000.00' }, ...bandDims('14000.00', '40000.00', '0.00'), ...tail('2', '8.00', '40000.00', '1')]),
  },
  {
    kind: 'period_edge', name: 'fim de semana no meio: sexta a quarta são 5 dias corridos e 3 úteis; com alerta de 2 dias úteis o repasse passa e as faixas seguem o parâmetro',
    input: input({ total: '100.00', count: 1, byOwner: { d1: '100.00' }, byProperty: { i1: '100.00' }, byAge: [{ count: 1, amount: '100.00', calendarDays: 5, businessDays: 3 }] }), params: { alertBusinessDays: 2, bands: [1, 3] },
    expected: okOf('100.00', detailsOf('1', '5.00', '2', '1', '100.00'), [{ key: 'proprietario:d1', value: '100.00' }, { key: 'imovel:i1', value: '100.00' }, ...bandDims('0.00', '100.00', '0.00', [1, 3]), ...tail('1', '5.00', '100.00', '1')]),
  },
  {
    kind: 'rounding', name: 'idade média com meio centésimo arredonda para cima (1 dia em 8 repasses = 0,13)', input: input({ total: '80.00', count: 8, byOwner: { d1: '80.00' }, byProperty: { i1: '80.00' }, byAge: [{ count: 1, amount: '10.00', calendarDays: 1, businessDays: 1 }, { count: 7, amount: '70.00', calendarDays: 0, businessDays: 0 }] }),
    expected: okOf('80.00', detailsOf('8', '0.13', '5', '0', '0.00'), [{ key: 'proprietario:d1', value: '80.00' }, { key: 'imovel:i1', value: '80.00' }, ...bandDims('80.00', '0.00', '0.00'), ...tail('8', '0.13', '0.00', '0')]),
  },
];

module.exports = { id: 'fin.owner_repasses_pending', version: 1, compute, testCases };
