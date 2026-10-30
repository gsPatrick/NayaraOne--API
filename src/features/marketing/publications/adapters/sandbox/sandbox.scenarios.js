'use strict';

const crypto = require('node:crypto');
const { canonicalize } = require('../../../../integrations/dispatch/canonicalJson');
const { invalid } = require('../channel.errors');

/** Os 10 cenários injetáveis do sandbox (M9-D430 3.3). Sem flag de cenário, vale OK. */
const SCENARIOS = Object.freeze(['OK', 'TIMEOUT', 'UNKNOWN_BUT_PUBLISHED', 'UNKNOWN_NOT_PUBLISHED', 'HTTP_429', 'HTTP_5XX', 'AUTH_REVOKED', 'REJECTED', 'DUPLICATE_KEY', 'SLOW']);
const HEADER = 'x-mkt-sandbox-scenario';

/** Cenário pedido: opção `scenario` ou cabeçalho de teste; desconhecido é 422. */
function pickScenario({ scenario, headers } = {}) {
  const fromHeader = headers && (headers[HEADER] || headers[HEADER.toUpperCase()]);
  const chosen = scenario || fromHeader || null;
  if (chosen === null) return null;
  const name = String(chosen).toUpperCase();
  if (!SCENARIOS.includes(name)) throw invalid('Cenário de teste desconhecido.', { campo: 'scenario', validos: SCENARIOS });
  return name;
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
/** Hash determinístico do que o canal recebeu: o resultado do sandbox é função dele (sem relógio nem aleatoriedade). */
const payloadHash = (channel, operation, payload) => sha256(`${channel}|${operation}|${canonicalize(payload)}`);
const refOf = (channel, key, hash) => `sbx-${channel.toLowerCase()}-${sha256(`${key}|${hash}`).slice(0, 16)}`;

module.exports = { SCENARIOS, HEADER, pickScenario, payloadHash, refOf, sha256 };
