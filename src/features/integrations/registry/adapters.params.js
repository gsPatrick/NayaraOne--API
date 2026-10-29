'use strict';

const { getSetting } = require('../../settings/settings.service');

/** Padrões do parametros.csv, usados quando a empresa não configurou. */
const PADROES = Object.freeze({ healthCheckTimeoutMs: 5000, readTimeoutMs: 10000, writeTimeoutMs: 20000 });

const inteiro = (v, padrao, min) => (Number.isInteger(v) && v >= min ? v : padrao);

async function readAdapterParams(tenant, transaction) {
  const [health, read, write] = await Promise.all([
    getSetting('integration.health.check_timeout_ms', tenant, transaction, PADROES.healthCheckTimeoutMs),
    getSetting('integration.dispatch.timeout_ms.read', tenant, transaction, PADROES.readTimeoutMs),
    getSetting('integration.dispatch.timeout_ms.write', tenant, transaction, PADROES.writeTimeoutMs),
  ]);
  return {
    healthCheckTimeoutMs: inteiro(health, PADROES.healthCheckTimeoutMs, 500),
    readTimeoutMs: inteiro(read, PADROES.readTimeoutMs, 1000),
    writeTimeoutMs: inteiro(write, PADROES.writeTimeoutMs, 1000),
  };
}

module.exports = { PADROES, readAdapterParams };
