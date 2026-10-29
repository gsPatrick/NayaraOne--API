'use strict';

/**
 * M9-D652 / M9-D653 — peças comuns das fórmulas dos KPIs de desperdício, custo pós-obra, recorrência e de Estoque/Patrimônio: mensagem de dado
 * incompleto, resultado sem valor (DEGRADED quando a regra de qualidade falha, INCOMPLETE quando falta base: nunca um número enganoso) e a soma por chave.
 * Aritmética sempre em decimal exato (money.js), arredondando UMA vez no fim (M9-D605). Sem relógio e sem banco: a data-base entra como `asOfDate`.
 */
const money = require('./money');

const INCOMPLETE_MESSAGE = 'Dado incompleto, valor não confiável.';

const withoutValue = (status, reason, details = {}, dimensions = []) => ({ value: null, status, message: INCOMPLETE_MESSAGE, details: { reason, ...details }, dimensions });
const degraded = (reason, details, dimensions) => withoutValue('DEGRADED', reason, details, dimensions);
const incomplete = (reason, details, dimensions) => withoutValue('INCOMPLETE', reason, details, dimensions);

const orZero = (value) => (value === undefined || value === null || value === '' ? 0 : value);
const sumMoney = (list) => money.sum(list.map(orZero));

/** Soma por chave: devolve Map chave -> soma exata (BigInt escalado) na ordem de inserção. */
function groupSum(rows, keyOf, valueOf) {
  const out = new Map();
  for (const r of rows) {
    const key = keyOf(r);
    out.set(key, money.add(out.get(key) || 0, orZero(valueOf(r))));
  }
  return out;
}

const byKey = (map) => [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

module.exports = { INCOMPLETE_MESSAGE, degraded, incomplete, orZero, sumMoney, groupSum, byKey };
