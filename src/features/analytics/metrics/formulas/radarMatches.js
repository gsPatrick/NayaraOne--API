'use strict';

/**
 * M9-D633 — KPI radar.matches (Radar matches), versão 1. Valor = cruzamentos gerados pelo Radar no período (dia do evento radar.matched, São Paulo).
 * Mostra os já avisados (evento publicado ou tratado), os convertidos (a pessoa do radar tem oportunidade ganha no mesmo imóvel) e a taxa =
 * convertidos ÷ gerados × 100 (2 casas, uma vez), por origem do perfil (com oportunidade, avulso) e por corretor do perfil. Entrada (soma dos dias do
 * rm_radar_matches): { matches, sent, converted, invalid, byOrigin, byBroker }. Regra de qualidade: cruzamento sem perfil (radar) ou sem imóvel ativo
 * -> DEGRADED, valor nulo. Sem cruzamento a taxa não existe (sem dimensão), nunca vira 0%.
 */
const money = require('./money');
const { degraded, count, brokerDimensions, keyedDimensions } = require('./_bizKpi');

function compute(input) {
  const matches = count(input.matches);
  const sent = count(input.sent);
  const converted = count(input.converted);
  const invalid = count(input.invalid);
  const details = { matches, sent, converted, invalid };
  if (invalid !== '0') return degraded('MATCH_SEM_PERFIL_OU_IMOVEL_ATIVO', details, [{ key: 'enviados', value: sent }, { key: 'convertidos', value: converted }]);
  const rate = money.percent(converted, matches);
  const dimensions = [{ key: 'enviados', value: sent }, { key: 'convertidos', value: converted }];
  if (rate.value !== null) dimensions.push({ key: 'taxa_pct', value: rate.value });
  dimensions.push(...keyedDimensions('origem', input.byOrigin), ...brokerDimensions(input.byBroker, 'matches'));
  return { value: matches, status: 'OK', details: { ...details, conversionPct: rate.value }, dimensions };
}

const input = (extra = {}) => ({ matches: 85, sent: 80, converted: 9, invalid: 0, byOrigin: { AVULSO: 25, COM_OPORTUNIDADE: 60 }, byBroker: { b1: 85 }, ...extra });
const okOf = (matches, sent, converted, pct, rest = []) => ({
  value: matches, status: 'OK', details: { matches, sent, converted, invalid: '0', conversionPct: pct },
  dimensions: [{ key: 'enviados', value: sent }, { key: 'convertidos', value: converted }, ...(pct === null ? [] : [{ key: 'taxa_pct', value: pct }]), ...rest],
});

const testCases = [
  { kind: 'empty', name: 'nenhum cruzamento no período: zero e sem taxa (nunca 0%)', input: input({ matches: 0, sent: 0, converted: 0, byOrigin: {}, byBroker: {} }), expected: okOf('0', '0', '0', null) },
  { kind: 'single', name: 'um cruzamento convertido: taxa 100,00%', input: input({ matches: 1, sent: 1, converted: 1, byOrigin: { AVULSO: 1 }, byBroker: { b1: 1 } }), expected: okOf('1', '1', '1', '100.00', [{ key: 'origem:AVULSO', value: '1' }, { key: 'corretor:b1:matches', value: '1' }]) },
  {
    kind: 'typical', name: 'exemplo do livro: 85 gerados, 9 convertidos => 10,59%', input: input(),
    expected: okOf('85', '80', '9', '10.59', [{ key: 'origem:AVULSO', value: '25' }, { key: 'origem:COM_OPORTUNIDADE', value: '60' }, { key: 'corretor:b1:matches', value: '85' }]),
  },
  { kind: 'period_edge', name: 'contagens em texto do banco entram como inteiros', input: input({ matches: '4', sent: '4', converted: '1', byOrigin: {}, byBroker: {} }), expected: okOf('4', '4', '1', '25.00') },
  { kind: 'rounding', name: 'taxa 2 de 3 arredonda uma vez, meio para cima: 66,67%', input: input({ matches: 3, sent: 3, converted: 2, byOrigin: {}, byBroker: {} }), expected: okOf('3', '3', '2', '66.67') },
  {
    kind: 'period_edge', name: 'cruzamento sem perfil ou sem imóvel ativo: DEGRADED e sem valor', input: input({ invalid: 4 }),
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'MATCH_SEM_PERFIL_OU_IMOVEL_ATIVO', matches: '85', sent: '80', converted: '9', invalid: '4' }, dimensions: [{ key: 'enviados', value: '80' }, { key: 'convertidos', value: '9' }] },
  },
];

module.exports = { id: 'radar.matches', version: 1, compute, testCases };
