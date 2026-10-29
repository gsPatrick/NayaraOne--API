'use strict';

/**
 * M9-D642 — KPI rent.satisfaction (Satisfação da locação), versão 1. Fluxo no mês de São Paulo da data-base: média aritmética das notas (1 a 5 no livro) das respostas ligadas a contratos de
 * locação = Σ notas ÷ respostas, 2 casas, arredondada uma só vez, mais o número de respostas; também a média separada por inquilino e por proprietário (o papel só mostra a média com
 * ao menos minSample respostas, senão fica sem média). Menos de minSample respostas no total (analytics.qualidade.min_amostra) -> INCOMPLETE, valor nulo. Entrada (rm_rental_satisfaction,
 * linha do mês): { row: { responses, scoreSum, tenantResponses, tenantScoreSum, ownerResponses, ownerScoreSum } | null } (sem linha = mês sem respostas). Campo nulo (ainda não
 * calculado pelo read model) -> DEGRADED, valor nulo.
 */
const money = require('./money');
const { degraded, incomplete } = require('./_legalCorKpi');

const FIELDS = ['responses', 'scoreSum', 'tenantResponses', 'tenantScoreSum', 'ownerResponses', 'ownerScoreSum'];
const ROLES = [['INQUILINO', 'tenant'], ['PROPRIETARIO', 'owner']];

function compute(input, params = {}) {
  const minSample = Number.isInteger(params.minSample) && params.minSample >= 1 ? params.minSample : 5;
  const row = input.row || { responses: 0, scoreSum: 0, tenantResponses: 0, tenantScoreSum: 0, ownerResponses: 0, ownerScoreSum: 0 };
  if (FIELDS.some((f) => row[f] === null || row[f] === undefined)) return degraded('READ_MODEL_NAO_RECALCULADO', {});
  const responses = money.count(row.responses);
  if (money.cmp(responses, minSample) < 0) return incomplete('AMOSTRA_INSUFICIENTE', { responses, minSample: String(minSample) });
  const scoreSum = money.count(row.scoreSum);
  const dimensions = [{ key: 'respostas_qtd', value: responses }];
  const roles = {};
  for (const [label, prefix] of ROLES) {
    const n = money.count(row[`${prefix}Responses`]);
    const average = money.cmp(n, minSample) >= 0 ? money.round(money.div(money.count(row[`${prefix}ScoreSum`]), n), 2) : null;
    roles[label] = { responses: n, average };
    dimensions.push({ key: `papel:${label}:respostas_qtd`, value: n });
    if (average !== null) dimensions.push({ key: `papel:${label}`, value: average });
  }
  return { value: money.round(money.div(scoreSum, responses), 2), status: 'OK', details: { responses, scoreSum, minSample: String(minSample), roles }, dimensions };
}

const row = (responses, scoreSum, tenantResponses = 0, tenantScoreSum = 0, ownerResponses = 0, ownerScoreSum = 0) => ({ responses, scoreSum, tenantResponses, tenantScoreSum, ownerResponses, ownerScoreSum });
const roleOf = (n, average) => ({ responses: n, average });
const okOf = (value, responses, scoreSum, minSample, tenant, owner) => ({
  value, status: 'OK', details: { responses, scoreSum, minSample, roles: { INQUILINO: tenant, PROPRIETARIO: owner } },
  dimensions: [{ key: 'respostas_qtd', value: responses }, { key: 'papel:INQUILINO:respostas_qtd', value: tenant.responses }, ...(tenant.average === null ? [] : [{ key: 'papel:INQUILINO', value: tenant.average }]),
    { key: 'papel:PROPRIETARIO:respostas_qtd', value: owner.responses }, ...(owner.average === null ? [] : [{ key: 'papel:PROPRIETARIO', value: owner.average }])],
});
const bad = (status, reason, details) => ({ value: null, status, message: 'Dado incompleto, valor não confiável.', details: { reason, ...details }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'mês sem respostas: INCOMPLETE e sem valor', params: { minSample: 5 }, input: { row: null }, expected: bad('INCOMPLETE', 'AMOSTRA_INSUFICIENTE', { responses: '0', minSample: '5' }) },
  { kind: 'single', name: 'uma resposta nota 5 com amostra mínima 1', params: { minSample: 1 }, input: { row: row(1, 5, 1, 5) }, expected: okOf('5.00', '1', '5', '1', roleOf('1', '5.00'), roleOf('0', null)) },
  {
    kind: 'typical', name: 'cinco respostas (3 de inquilino, 2 de proprietário) dão 3,80, 3,67 e 4,00', params: { minSample: 2 }, input: { row: row(5, 19, 3, 11, 2, 8) },
    expected: okOf('3.80', '5', '19', '2', roleOf('3', '3.67'), roleOf('2', '4.00')),
  },
  { kind: 'period_edge', name: 'exemplo da demanda: notas 5,4,4,5 dão 4,50 com 4 respostas e INCOMPLETE com mínimo 5', params: { minSample: 5 }, input: { row: row(4, 18, 4, 18) }, expected: bad('INCOMPLETE', 'AMOSTRA_INSUFICIENTE', { responses: '4', minSample: '5' }) },
  { kind: 'period_edge', name: 'as mesmas quatro respostas com mínimo 4 dão 4,50', params: { minSample: 4 }, input: { row: row(4, 18, 4, 18) }, expected: okOf('4.50', '4', '18', '4', roleOf('4', '4.50'), roleOf('0', null)) },
  { kind: 'period_edge', name: 'notas por papel ainda não calculadas pelo read model: DEGRADED e sem valor', params: { minSample: 5 }, input: { row: row(5, 20, null, null, null, null) }, expected: bad('DEGRADED', 'READ_MODEL_NAO_RECALCULADO', {}) },
  { kind: 'rounding', name: '31 pontos em 7 respostas dão 4,43 (meio para cima, uma vez); papel com amostra menor que o mínimo fica sem média', params: { minSample: 5 }, input: { row: row(7, 31, 7, 31, 1, 4) }, expected: okOf('4.43', '7', '31', '5', roleOf('7', '4.43'), roleOf('1', null)) },
];

module.exports = { id: 'rent.satisfaction', version: 1, compute, testCases };
