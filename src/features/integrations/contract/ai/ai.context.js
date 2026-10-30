'use strict';

const { SecretValue } = require('../../secrets/SecretValue');
const { makeAiHttpDouble } = require('./ai.http.double');

const SEGREDO_DE_CONTRATO = 'segredo-de-contrato-nao-real';

/**
 * Contexto de um adapter de modelo nos contract tests (M9-D011 + M9-D222): conexão de laboratório com o catálogo de modelos da fixture, cliente HTTP falso (só quando a
 * fixture declara `transport: "http"`) e segredo em memória. `fault` vira a falha do fornecedor falso; `fault.kind = 'noSecret'` tira a credencial do cofre.
 */
function buildAiContext({ providerCode, version, fixture, timeoutMs, healthTimeoutMs, fault = null }) {
  const real = fixture.transport === 'http';
  const double = real ? makeAiHttpDouble(fixture.wire || {}, fault && fault.kind !== 'noSecret' ? fault : null) : null;
  const ctx = Object.freeze({
    connection: Object.freeze({ id: `contract-${providerCode}`, providerCode, environment: 'SANDBOX', apiVersion: version, config: { baseUrl: 'https://contrato.invalid', models: fixture.models || [] } }),
    policy: {},
    timeouts: { readMs: timeoutMs, writeMs: timeoutMs },
    healthCheckTimeoutMs: healthTimeoutMs,
    http: double ? double.http : undefined,
    secret: async () => {
      if (fault && fault.kind === 'noSecret') throw new Error('segredo ausente do cofre');
      return { value: new SecretValue(SEGREDO_DE_CONTRATO) };
    },
  });
  return { ctx, calls: double ? double.calls : [] };
}

module.exports = { buildAiContext, SEGREDO_DE_CONTRATO };
