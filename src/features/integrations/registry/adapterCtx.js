'use strict';

const { IntegrationHttpClient } = require('../http/IntegrationHttpClient');
const { readConnectionSecret } = require('../secrets');
const { readAdapterParams } = require('./adapters.params');

/**
 * Monta o `ctx` que o adapter recebe (M9-D209 3.3): conexão SEM segredo e SEM empresa, política, tempos, cliente HTTP
 * único e um leitor de segredo preguiçoso (SecretStore, com a finalidade e a auditoria da D202). O adapter não conhece
 * empresa, usuário nem banco. Vale dentro da transação em que foi montado.
 */
async function buildAdapterCtx(connection, tenant, transaction) {
  const params = await readAdapterParams(tenant, transaction);
  const timeouts = { readMs: params.readTimeoutMs, writeMs: params.writeTimeoutMs };
  return Object.freeze({
    connection: Object.freeze({
      id: connection.id, providerCode: connection.providerCode, environment: connection.environment,
      apiVersion: connection.apiVersion || null, config: connection.configJson || {},
    }),
    policy: connection.policyJson || {},
    timeouts,
    healthCheckTimeoutMs: params.healthCheckTimeoutMs,
    http: new IntegrationHttpClient({ providerCode: connection.providerCode, connectionId: connection.id, timeouts }),
    secret: (purpose = 'dispatch', opts = {}) => readConnectionSecret(connection, tenant, { purpose, transaction, ...opts }),
  });
}

module.exports = { buildAdapterCtx };
