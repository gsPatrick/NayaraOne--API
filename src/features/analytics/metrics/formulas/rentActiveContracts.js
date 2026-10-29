'use strict';

/**
 * M9-D640 — KPI rent.active_contracts (Contratos de locação ativos), versão 1. Posição no fim do dia-base: contagem de contratos de locação com status ACTIVE e a soma do aluguel
 * mensal vigente (total_value, em reais, no valor planejado das dimensões); SUSPENDED aparece à parte. O valor é a contagem. Entrada (rm_rental_contracts, uma linha por situação):
 * { rows: [{ status, count, rentTotal, withoutRent, byProperty, byOwner, rentDistribution: [{ rent, count }] }] }; parâmetro: rentBands (limites, em reais, das faixas de valor).
 * Regra de qualidade: contrato ACTIVE sem valor de aluguel (nulo ou zero) -> DEGRADED, valor nulo, contado em details.withoutRent; contagem ainda não calculada pelo read model -> DEGRADED.
 */
const money = require('./money');
const { degraded, byText } = require('./_legalCorKpi');

const DEFAULT_BANDS = Object.freeze([2000, 5000, 10000]);

function bandLabels(limits) {
  return [`ate_${limits[0]}`, ...limits.slice(1).map((limit, i) => `${limits[i] + 1}-${limit}`), `acima_${limits[limits.length - 1]}`];
}

const bandIndex = (rent, limits) => {
  const i = limits.findIndex((limit) => money.cmp(rent, limit) <= 0);
  return i === -1 ? limits.length : i;
};

const mapDimensions = (prefix, map) => Object.keys(map || {}).sort(byText).flatMap((id) => [
  { key: `${prefix}:${id}`, value: money.count(map[id].count) }, { key: `${prefix}:${id}:aluguel_brl`, value: money.money(map[id].rent) },
]);

function compute(input, params = {}) {
  const limits = Array.isArray(params.rentBands) && params.rentBands.length ? params.rentBands : DEFAULT_BANDS;
  const rows = input.rows || [];
  const active = rows.find((r) => r.status === 'ACTIVE');
  const suspended = rows.find((r) => r.status === 'SUSPENDED');
  if (active && (active.withoutRent === null || active.withoutRent === undefined)) return degraded('READ_MODEL_NAO_RECALCULADO', {});
  const count = active ? money.count(active.count) : '0';
  const withoutRent = active ? money.count(active.withoutRent) : '0';
  if (withoutRent !== '0') return degraded('CONTRATO_SEM_VALOR_DE_ALUGUEL', { withoutRent, active: count });
  const rent = active ? money.money(active.rentTotal) : '0.00';
  const labels = bandLabels(limits);
  const bands = Object.fromEntries(labels.map((l) => [l, '0']));
  for (const d of (active && active.rentDistribution) || []) {
    const label = labels[bandIndex(d.rent, limits)];
    bands[label] = money.count(money.add(bands[label], d.count));
  }
  const suspendedCount = suspended ? money.count(suspended.count) : '0';
  const dimensions = [
    { key: 'aluguel_mensal_brl', value: rent }, { key: 'suspensos_qtd', value: suspendedCount },
    ...labels.map((l) => ({ key: `faixa_valor:${l}`, value: bands[l] })),
    ...mapDimensions('imovel', active && active.byProperty), ...mapDimensions('proprietario', active && active.byOwner),
  ];
  return { value: count, status: 'OK', details: { monthlyRent: rent, suspended: suspendedCount, withoutRent }, dimensions };
}

const row = (status, count, rentTotal, extra = {}) => ({ status, count, rentTotal, withoutRent: 0, byProperty: {}, byOwner: {}, rentDistribution: [], ...extra });
const faixas = (a, b, c, d) => [{ key: 'faixa_valor:ate_2000', value: a }, { key: 'faixa_valor:2001-5000', value: b }, { key: 'faixa_valor:5001-10000', value: c }, { key: 'faixa_valor:acima_10000', value: d }];
const okOf = (value, rent, suspended, bands, extra = []) => ({
  value, status: 'OK', details: { monthlyRent: rent, suspended, withoutRent: '0' }, dimensions: [{ key: 'aluguel_mensal_brl', value: rent }, { key: 'suspensos_qtd', value: suspended }, ...bands, ...extra],
});
const bad = (reason, details) => ({ value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason, ...details }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhum contrato: zero contratos e aluguel 0,00', input: { rows: [] }, expected: okOf('0', '0.00', '0', faixas('0', '0', '0', '0')) },
  {
    kind: 'single', name: 'um contrato de 2.500,00 no imóvel p1 do proprietário o1',
    input: { rows: [row('ACTIVE', 1, '2500.00', { byProperty: { p1: { count: 1, rent: '2500.00' } }, byOwner: { o1: { count: 1, rent: '2500.00' } }, rentDistribution: [{ rent: '2500.00', count: 1 }] })] },
    expected: okOf('1', '2500.00', '0', faixas('0', '1', '0', '0'), [{ key: 'imovel:p1', value: '1' }, { key: 'imovel:p1:aluguel_brl', value: '2500.00' }, { key: 'proprietario:o1', value: '1' }, { key: 'proprietario:o1:aluguel_brl', value: '2500.00' }]),
  },
  {
    kind: 'typical', name: 'exemplo do livro: 85 contratos, aluguel mensal 212.500,00; os suspensos aparecem à parte',
    input: { rows: [row('ACTIVE', 85, '212500.00', { rentDistribution: [{ rent: '1500.00', count: 20 }, { rent: '2500.00', count: 60 }, { rent: '7000.00', count: 5 }] }), row('SUSPENDED', 3, '6000.00'), row('TERMINATED', 9, '1.00')] },
    expected: okOf('85', '212500.00', '3', faixas('20', '60', '5', '0')),
  },
  {
    kind: 'period_edge', name: 'aluguel exatamente no limite da faixa fica na faixa de baixo; faixas do administrador mudam o corte', params: { rentBands: [1000, 3000] },
    input: { rows: [row('ACTIVE', 4, '8000.00', { rentDistribution: [{ rent: '1000.00', count: 1 }, { rent: '1000.01', count: 1 }, { rent: '3000.00', count: 1 }, { rent: '3000.01', count: 1 }] })] },
    expected: {
      value: '4', status: 'OK', details: { monthlyRent: '8000.00', suspended: '0', withoutRent: '0' },
      dimensions: [{ key: 'aluguel_mensal_brl', value: '8000.00' }, { key: 'suspensos_qtd', value: '0' }, { key: 'faixa_valor:ate_1000', value: '1' }, { key: 'faixa_valor:1001-3000', value: '2' }, { key: 'faixa_valor:acima_3000', value: '1' }],
    },
  },
  {
    kind: 'rounding', name: 'aluguel com mais de duas casas arredonda uma só vez, meio para cima', input: { rows: [row('ACTIVE', 2, '100.005', { rentDistribution: [{ rent: '50.0025', count: 2 }] })] },
    expected: okOf('2', '100.01', '0', faixas('2', '0', '0', '0')),
  },
  { kind: 'period_edge', name: 'contrato ACTIVE sem valor de aluguel: DEGRADED e sem valor', input: { rows: [row('ACTIVE', 10, '5000.00', { withoutRent: 2 })] }, expected: bad('CONTRATO_SEM_VALOR_DE_ALUGUEL', { withoutRent: '2', active: '10' }) },
  { kind: 'period_edge', name: 'read model ainda não recalculado (contagem nula): DEGRADED e sem valor', input: { rows: [row('ACTIVE', 10, '5000.00', { withoutRent: null })] }, expected: bad('READ_MODEL_NAO_RECALCULADO', {}) },
];

module.exports = { id: 'rent.active_contracts', version: 1, compute, testCases };
