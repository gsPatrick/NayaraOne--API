'use strict';

/**
 * M9-D650 / M9-D651 — peças comuns das fórmulas dos KPIs de Obras: mensagem de dado incompleto, resultado sem valor (INCOMPLETE ou DEGRADED:
 * nunca um número enganoso), percentual com 2 casas calculado de valores exatos e a ordenação estável das obras. Aritmética sempre em decimal
 * exato (money.js), arredondando UMA vez no fim (M9-D605). Sem relógio, sem banco: a data-base entra como `asOfDate`.
 */
const money = require('./money');

const INCOMPLETE_MESSAGE = 'Dado incompleto, valor não confiável.';

const withoutValue = (status, reason, details = {}) => ({ value: null, status, message: INCOMPLETE_MESSAGE, details: { reason, ...details }, dimensions: [] });
const incomplete = (reason, details) => withoutValue('INCOMPLETE', reason, details);
const degraded = (reason, details) => withoutValue('DEGRADED', reason, details);

/** parte ÷ total × 100, 2 casas, a partir de valores exatos. Total zero devolve null (quem chama decide). */
function pct2(part, total) {
  const ratio = money.div(part, total);
  return ratio === null ? null : money.round(money.mul(ratio, 100), 2);
}

/** Média (soma ÷ quantidade) com `places` casas, arredondada uma vez. Quantidade zero devolve null. */
function average(sum, count, places) {
  const ratio = money.div(sum, count);
  return ratio === null ? null : money.round(ratio, places);
}

/** Obras em ordem de id: o resultado e o hash do cálculo não dependem da ordem em que o banco devolveu as linhas. */
const sortedById = (projects, idKey = 'id') => [...(projects || [])].sort((a, b) => (String(a[idKey]) < String(b[idKey]) ? -1 : 1));

const total = (list, pick) => money.sum(list.map(pick));

module.exports = { INCOMPLETE_MESSAGE, incomplete, degraded, pct2, average, sortedById, total };
