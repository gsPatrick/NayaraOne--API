'use strict';

/**
 * M9-D604 (3.5) — recálculo de um valor passado: a versão da época (e a fórmula dela), as mesmas entradas e os mesmos parâmetros dão o
 * mesmo valor e o mesmo calc_hash do snapshot. `recalculate` é pura (sem banco, relógio ou sorteio); `asOfDate` entra como parâmetro.
 */
const { calcHash } = require('./calcHash');

function recalculate({ formula, metricCode, version, inputs, params = {}, asOfDate }) {
  const result = formula.compute(inputs, { ...params, asOfDate });
  return { value: result.value, details: result.details, calcHash: calcHash({ metricCode, version, inputs, params }) };
}

module.exports = { recalculate };
