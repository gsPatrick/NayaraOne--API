'use strict';

/**
 * M9-D604 (3.5) / M9-D605 (3.4) — hash de reprodução do cálculo: sha256(metric_code | version | JSON canônico ordenado das
 * entradas | parâmetros). Recalcular com a mesma versão e as mesmas entradas dá o mesmo valor e o mesmo hash. Função pura.
 */
const { createHash } = require('node:crypto');
const { canonical } = require('./formulaCatalog');

function calcHash({ metricCode, version, inputs, params }) {
  const text = [metricCode, String(version), canonical(inputs === undefined ? [] : inputs), canonical(params === undefined ? {} : params)].join('|');
  return createHash('sha256').update(text).digest('hex');
}

module.exports = { calcHash };
