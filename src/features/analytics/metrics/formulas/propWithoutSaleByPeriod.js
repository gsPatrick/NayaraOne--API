'use strict';

/**
 * M9-D632 — KPI prop.without_sale_by_period (Imóveis sem venda por período), versão 1. Posição na data-base: imóveis disponíveis, publicados e com
 * oferta de venda ativa, distribuídos pelos dias sem venda (da publicação até a data-base, calendário de São Paulo) nas faixas do administrador
 * (padrão do livro: 0-30, 31-90, 91-180 e 181+). Valor = imóveis nas faixas. A última faixa é a lista de atenção (drill-down). Entrada
 * (rm_property_portfolio, linhas AVAILABLE): { bands: [{ label, count }] na ordem das faixas, noDate }. Regra de qualidade: imóvel publicado sem data de entrada
 * no mercado fica fora das faixas, contado em "Sem data", e o KPI sai DEGRADED com valor nulo.
 */
const { degraded, count, sumCounts } = require('./_bizKpi');

function compute(input) {
  const bands = (input.bands || []).map((b) => ({ label: String(b.label), count: count(b.count) }));
  const noDate = count(input.noDate);
  const total = sumCounts(bands.map((b) => b.count));
  const last = bands.length ? bands[bands.length - 1] : null;
  const details = { total, noDate, overLastBand: last ? last.count : '0', lastBand: last ? last.label : null };
  const dimensions = [...bands.map((b) => ({ key: `faixa:${b.label}`, value: b.count })), { key: 'sem_data', value: noDate }];
  if (noDate !== '0') return degraded('IMOVEL_SEM_DATA_DE_ENTRADA', details, dimensions);
  return { value: total, status: 'OK', details, dimensions };
}

const LABELS = ['ATE_30', '31_A_90', '91_A_180', 'ACIMA_180'];
const bandsOf = (counts) => LABELS.map((label, i) => ({ label, count: counts[i] }));
const input = (extra = {}) => ({ bands: bandsOf([40, 48, 30, 22]), noDate: 0, ...extra });
const okOf = (counts, total, noDate = '0') => ({
  value: total, status: 'OK', details: { total, noDate, overLastBand: counts[3], lastBand: 'ACIMA_180' },
  dimensions: [...LABELS.map((label, i) => ({ key: `faixa:${label}`, value: counts[i] })), { key: 'sem_data', value: noDate }],
});

const testCases = [
  { kind: 'empty', name: 'nenhum imóvel à venda: zero em todas as faixas', input: input({ bands: bandsOf([0, 0, 0, 0]) }), expected: okOf(['0', '0', '0', '0'], '0') },
  { kind: 'single', name: 'um imóvel há mais de 180 dias', input: input({ bands: bandsOf([0, 0, 0, 1]) }), expected: okOf(['0', '0', '0', '1'], '1') },
  { kind: 'typical', name: 'exemplo do livro: 40, 48, 30 e 22 (181+) => 140', input: input(), expected: okOf(['40', '48', '30', '22'], '140') },
  { kind: 'period_edge', name: 'faixas do administrador mudam os rótulos e a última faixa segue sendo a de atenção', input: { bands: [{ label: 'ATE_10', count: 2 }, { label: 'ACIMA_10', count: 5 }], noDate: 0 }, expected: { value: '7', status: 'OK', details: { total: '7', noDate: '0', overLastBand: '5', lastBand: 'ACIMA_10' }, dimensions: [{ key: 'faixa:ATE_10', value: '2' }, { key: 'faixa:ACIMA_10', value: '5' }, { key: 'sem_data', value: '0' }] } },
  { kind: 'rounding', name: 'contagens em texto do banco entram como inteiros', input: input({ bands: bandsOf(['1', '2', '3', '4']) }), expected: okOf(['1', '2', '3', '4'], '10') },
  {
    kind: 'period_edge', name: 'imóvel sem data de entrada: fora das faixas, contado em Sem data, DEGRADED e sem valor', input: input({ noDate: 2 }),
    expected: {
      value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'IMOVEL_SEM_DATA_DE_ENTRADA', total: '140', noDate: '2', overLastBand: '22', lastBand: 'ACIMA_180' },
      dimensions: [...LABELS.map((label, i) => ({ key: `faixa:${label}`, value: ['40', '48', '30', '22'][i] })), { key: 'sem_data', value: '2' }],
    },
  },
];

module.exports = { id: 'prop.without_sale_by_period', version: 1, compute, testCases };
