'use strict';

/**
 * M9-D691 (3.1 passo 4) — fingerprint do alerta: SHA-256 de `metric_code | escopo canônico | condição canônica`. Mesmo problema, mesmo
 * fingerprint; empresa, dimensão, operador, valor, regra ou versão da regra diferentes, fingerprint diferente. JSON canônico: chaves em ordem
 * e número em forma única (50000 e 50000.0 são o mesmo).
 */
const crypto = require('node:crypto');

function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

/** { metricCode, companyId, scope: {dimensões}, condition: { type, operator, value } | { type: 'RULE_ENGINE', ruleId, ruleVersion } }. */
function fingerprintOf({ metricCode, companyId, scope = {}, condition }) {
  const text = [metricCode, canonical({ companyId, dimensions: scope }), canonical(condition)].join('|');
  return crypto.createHash('sha256').update(text).digest('hex');
}

module.exports = { fingerprintOf, canonical };
