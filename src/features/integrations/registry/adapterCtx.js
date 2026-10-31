'use strict';

const { IntegrationHttpClient } = require('../http/IntegrationHttpClient');
const { readConnectionSecret } = require('../secrets');
const { readAdapterParams } = require('./adapters.params');
const { readEgressParams } = require('../http/egress.params');
const { makeEgressRecorder } = require('../http/egress.record');
const { readProviderHosts } = require('../http/providerHosts.params');
const { readPrivateHosts } = require('../http/privateHosts.params');
const { readSsrfParams } = require('../http/ssrf/ssrf.params');
const { hostPatternProblem } = require('../http/egressHostRules');

/**
 * Monta o `ctx` que o adapter recebe (M9-D209 3.3): conexão SEM segredo e SEM empresa, política, tempos, cliente HTTP
 * único e um leitor de segredo preguiçoso (SecretStore, com a finalidade e a auditoria da D202). O adapter não conhece
 * empresa, usuário nem banco. Vale dentro da transação em que foi montado.
 */
/** Hosts que a conexão pode chamar: os que o adapter declara + `policy.egressHosts` da conexão (config validada; URL de terceiro nunca entra, M9-D245). */
const egressHostsOf = (connection, adapterHosts) => {
  const daPolitica = ((connection.policyJson || {}).egressHosts || []).filter((h) => !hostPatternProblem(h)); // IP e nome interno nunca entram (M9-D245)
  return [...new Set([...(adapterHosts || []), ...daPolitica].map(String))];
};

async function buildAdapterCtx(connection, tenant, transaction, { adapterHosts = [] } = {}) {
  const params = await readAdapterParams(tenant, transaction);
  const egress = await readEgressParams(tenant, transaction);
  // Hosts que o fornecedor aceita como endereço base: os do adaptador mais o parâmetro da empresa (M9-D245); `policy.egressHosts` não amplia esta lista.
  const baseUrlHosts = [...new Set([...(adapterHosts || []), ...(await readProviderHosts(connection.providerCode, tenant, transaction))])];
  // Hosts de rede própria que a empresa liberou para este fornecedor (M9-D244, N7): entram na lista de saída e na exceção de destino, só deles.
  const privateHosts = await readPrivateHosts(connection.providerCode, tenant, transaction);
  const { allowedPorts } = await readSsrfParams(tenant, transaction); // portas de saída (padrão 443; só a plataforma muda)
  const timeouts = { readMs: params.readTimeoutMs, writeMs: params.writeTimeoutMs };
  return Object.freeze({
    connection: Object.freeze({
      id: connection.id, providerCode: connection.providerCode, environment: connection.environment,
      apiVersion: connection.apiVersion || null, config: connection.configJson || {},
    }),
    policy: connection.policyJson || {},
    baseUrlHosts: Object.freeze(baseUrlHosts),
    privateHosts: Object.freeze(privateHosts),
    timeouts,
    healthCheckTimeoutMs: params.healthCheckTimeoutMs,
    http: new IntegrationHttpClient({
      providerCode: connection.providerCode, connectionId: connection.id, timeouts, allowedHosts: [...egressHostsOf(connection, baseUrlHosts), ...privateHosts], privateHosts, allowedPorts,
      environment: connection.environment, egressMode: egress.mode, onEgress: makeEgressRecorder(tenant, connection, transaction),
      // M9-D216: leitura e operação idempotente repetem até `integration.dispatch.call_attempts.idempotent`; o que altera estado (emissão) faz UMA tentativa:
      // a repetição dessa é do Dispatch Service (por classe de erro), nunca escondida dentro da chamada (INT-005).
      maxAttempts: params.idempotentAttempts, stateChangeMaxAttempts: 1,
    }),
    secret: (purpose = 'dispatch', opts = {}) => readConnectionSecret(connection, tenant, { purpose, transaction, ...opts }),
  });
}

module.exports = { buildAdapterCtx, egressHostsOf };
