'use strict';

/**
 * M9-D632 — KPI prop.active_properties (Imóveis ativos), versão 1. Posição na data-base: imóveis disponíveis (AVAILABLE, não excluídos nem
 * inativos na publicação). Por finalidade: com oferta de venda ativa (venda), só com oferta de locação ativa (locação) e sem oferta ativa
 * (a diferença); por tipo. Entrada (rm_property_portfolio, linhas AVAILABLE): { total, sale, rent, withoutStatus, byType: { tipo: n } }.
 * Regra de qualidade: imóvel sem status -> DEGRADED, valor nulo (o total só vale com todos os imóveis classificados).
 */
const money = require('./money');
const { degraded, count, keyedDimensions } = require('./_bizKpi');

function compute(input) {
  const total = count(input.total);
  const sale = count(input.sale);
  const rent = count(input.rent);
  const withoutStatus = count(input.withoutStatus);
  const noOffer = money.count(money.sub(total, money.add(sale, rent)));
  const details = { total, sale, rent, noOffer, withoutStatus };
  const dimensions = [{ key: 'finalidade:VENDA', value: sale }, { key: 'finalidade:LOCACAO', value: rent }, { key: 'finalidade:SEM_OFERTA', value: noOffer }, ...keyedDimensions('tipo', input.byType)];
  if (withoutStatus !== '0') return degraded('IMOVEL_SEM_STATUS', details, dimensions);
  return { value: total, status: 'OK', details, dimensions };
}

const input = (extra = {}) => ({ total: 140, sale: 90, rent: 50, withoutStatus: 0, byType: { APARTMENT: 100, HOUSE: 40 }, ...extra });
const okOf = (total, sale, rent, noOffer, types = []) => ({
  value: total, status: 'OK', details: { total, sale, rent, noOffer, withoutStatus: '0' },
  dimensions: [{ key: 'finalidade:VENDA', value: sale }, { key: 'finalidade:LOCACAO', value: rent }, { key: 'finalidade:SEM_OFERTA', value: noOffer }, ...types],
});

const testCases = [
  { kind: 'empty', name: 'nenhum imóvel disponível: zero', input: input({ total: 0, sale: 0, rent: 0, byType: {} }), expected: okOf('0', '0', '0', '0') },
  { kind: 'single', name: 'um imóvel só com oferta de venda', input: input({ total: 1, sale: 1, rent: 0, byType: { HOUSE: 1 } }), expected: okOf('1', '1', '0', '0', [{ key: 'tipo:HOUSE', value: '1' }]) },
  {
    kind: 'typical', name: 'exemplo do livro: 140 ativos, venda 90, locação 50', input: input(),
    expected: okOf('140', '90', '50', '0', [{ key: 'tipo:APARTMENT', value: '100' }, { key: 'tipo:HOUSE', value: '40' }]),
  },
  { kind: 'period_edge', name: 'imóvel sem oferta ativa aparece em SEM_OFERTA e o total não muda', input: input({ total: 10, sale: 4, rent: 3, byType: {} }), expected: okOf('10', '4', '3', '3') },
  { kind: 'rounding', name: 'contagens em texto do banco entram como inteiros, sem casas', input: input({ total: '7', sale: '5', rent: '2', byType: { LAND: '7' } }), expected: okOf('7', '5', '2', '0', [{ key: 'tipo:LAND', value: '7' }]) },
  {
    kind: 'period_edge', name: 'imóvel sem status: DEGRADED e sem valor', input: input({ withoutStatus: 3 }),
    expected: {
      value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'IMOVEL_SEM_STATUS', total: '140', sale: '90', rent: '50', noOffer: '0', withoutStatus: '3' },
      dimensions: [{ key: 'finalidade:VENDA', value: '90' }, { key: 'finalidade:LOCACAO', value: '50' }, { key: 'finalidade:SEM_OFERTA', value: '0' }, { key: 'tipo:APARTMENT', value: '100' }, { key: 'tipo:HOUSE', value: '40' }],
    },
  },
];

module.exports = { id: 'prop.active_properties', version: 1, compute, testCases };
