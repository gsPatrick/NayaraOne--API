'use strict';

/**
 * M9-D605 (reabertura L-3) — porta única para EXECUTAR uma fórmula com a entrada vinda do read model. Antes de calcular, confere a forma da
 * entrada: tem de ser um objeto; null, undefined, texto, lista ou número dão 422 ANALYTICS_FORMULA_INPUT_INVALID (nunca `TypeError` cru). Fórmula
 * cujos casos de teste são todos `{ rows: [...] }` exige `rows` como lista de objetos: `{}` ou texto no lugar das linhas é entrada malformada e
 * não vira "OK, valor 0" (0 sem dado é só `rows: []`, o caso explícito de vazio). As fórmulas continuam puras; a validação mora aqui.
 */
const { inputInvalid } = require('./formulaErrors');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const allPlain = (list) => list.every(isPlainObject);
const shapeCache = new WeakMap();

/**
 * Formas de entrada que a fórmula declara pelos casos de teste: `rows` (todos os casos `{ rows: [...] }` ou lista), `list` (aceita lista de linhas,
 * usada na reconciliação com as linhas-fonte) e `rowsOnly` (nenhum caso é de outro formato, então `rows` é obrigatório).
 */
function shapeOf(formula) {
  if (shapeCache.has(formula)) return shapeCache.get(formula);
  const cases = Array.isArray(formula.testCases) ? formula.testCases : [];
  const isRows = (c) => isPlainObject(c.input) && Array.isArray(c.input.rows);
  const isList = (c) => Array.isArray(c.input);
  const shape = { list: cases.some(isList), rowsOnly: cases.length > 0 && cases.every((c) => isRows(c) || isList(c)) };
  shapeCache.set(formula, shape);
  return shape;
}

/** A fórmula declara entrada em linhas? Sim quando todos os casos de teste (no mínimo um) são `{ rows: [...] }` ou lista de linhas. */
const expectsRows = (formula) => shapeOf(formula).rowsOnly;

/** Lança ANALYTICS_FORMULA_INPUT_INVALID se a entrada não tem a forma que a fórmula declara. */
function assertFormulaInput(formula, input) {
  const shape = shapeOf(formula);
  if (Array.isArray(input)) {
    if (!shape.list || !allPlain(input)) throw inputInvalid();
    return;
  }
  if (!isPlainObject(input)) throw inputInvalid();
  if (shape.rowsOnly && (!Array.isArray(input.rows) || !allPlain(input.rows))) throw inputInvalid();
}

/** compute(input, params) com a entrada conferida; `params` ausente vira `{}`. */
function runFormula(formula, input, params = {}) {
  assertFormulaInput(formula, input);
  return formula.compute(input, params || {});
}

module.exports = { runFormula, assertFormulaInput, expectsRows };
