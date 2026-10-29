'use strict';

const { IntegrationHttpClient } = require('../http/IntegrationHttpClient');
const { readConnectionSecret } = require('../secrets');
const { readAdapterParams } = require('./adapters.params');
const { readEgressParams } = require('../http/egress.params');
const { makeEgressRecorder } = require('../http/egress.record');

/**
 * Monta o `ctx` que o adapter recebe (M9-D209 3.3): conexão SEM segredo e SEM empresa, política, tempos, cliente HTTP
 * único e um leitor de segredo preguiçoso (SecretStore, com a finalidade e a auditoria da D202). O adapter não conhece
 * empresa, usuário nem banco. Vale dentro da transação em que foi montado.
 */
/** Hosts que a conexão pode chamar: os que o adapter declara + `policy.egressHosts` da conexão (config validada; URL de terceiro nunca entra, M9-D245). */
const egressHostsOf = (connection, adapterHosts) => [...new Set([...(adapterHosts || []), ...((connection.policyJson || {}).egressHosts || [])].map(String))];

async function buildAdapterCtx(connection, tenant, transaction, { adapterHosts = [] } = {}) {
  const params = await readAdapterParams(tenant, transaction);
  const egress = await readEgressParams(tenant, transaction);
  const timeouts = { readMs: params.readTimeoutMs, writeMs: params.writeTimeoutMs };
  return Object.freeze({
    connection: Object.freeze({
      id: connection.id, providerCode: connection.providerCode, environment: connection.environment,
      apiVersion: connection.apiVersion || null, config: connection.configJson || {},
    }),
    policy: connection.policyJson || {},
    timeouts,
    healthCheckTimeoutMs: params.healthCheckTimeoutMs,
    http: new IntegrationHttpClient({
      providerCode: connection.providerCode, connectionId: connection.id, timeouts, allowedHosts: egressHostsOf(connection, adapterHosts),
      environment: connection.environment, egressMode: egress.mode, onEgress: makeEgressRecorder(tenant, connection, transaction),
      maxAttempts: 1, // M9-D216: a repetição é do Dispatch Service (por classe de erro), nunca escondida dentro da chamada
    }),
    secret: (purpose = 'dispatch', opts = {}) => readConnectionSecret(connection, tenant, { purpose, transaction, ...opts }),
  });
}

module.exports = { buildAdapterCtx, egressHostsOf };
