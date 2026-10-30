'use strict';

const { CHANNEL_META } = require('../adapters/channels');
const { isChannelReleased } = require('../adapters/release/channelAccess');
const { ensureSandboxConnection, findActiveByDomain } = require('../../../integrations/registry/connections.ensureSandbox');
const { getCurrentHealth } = require('../../../integrations/health/healthQuery');
const { channelConnectionInactive } = require('./schedule.errors');
const { assertNetworkAuthorized } = require('../adapters/social');

/**
 * A conexão do canal para o agendamento (M9-D410 item 2): a ATIVA da família no framework de Integrações (canal liberado) ou a do sandbox da família
 * (canal ainda não liberado; fora de produção ela nasce sozinha, como nos outros módulos). Sem conexão ativa, ou com a saúde DOWN (circuito aberto ou
 * health checks seguidos falhos), o agendamento é recusado com 409 MKT_CHANNEL_CONNECTION_INACTIVE. UNKNOWN e DEGRADED não bloqueiam: conexão nova ainda
 * não tem amostra e degradada ainda atende (a contingência do canal decide no envio, M9-D430).
 */
async function resolveChannelConnection({ tenant, actor, channel, transaction, circuitAware = false }) {
  const meta = CHANNEL_META[channel];
  const ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: actor || null };
  let connection = null;
  try {
    connection = (await isChannelReleased(channel, tenant, transaction))
      ? await findActiveByDomain(ctx, meta.family, transaction)
      : await ensureSandboxConnection(ctx, { providerCode: meta.sandboxProvider, label: `Marketing: ${meta.family}` }, transaction);
  } catch (err) {
    if (err.code !== 'INTEGRATION_CONNECTION_NOT_FOUND') throw err;
  }
  if (!connection) throw channelConnectionInactive({ channel, reason: 'NO_ACTIVE_CONNECTION' });
  const health = await getCurrentHealth(connection.id, ctx, transaction);
  // circuitAware (worker, M9-D442): com o circuito OPEN/HALF_OPEN quem decide é o circuit breaker (admitCall: cooldown e meia-abertura), não esta recusa; senão o circuito nunca meia-abriria.
  const circuitDecides = circuitAware && ['OPEN', 'HALF_OPEN'].includes(health.circuitState);
  if (health.healthStatus === 'DOWN' && !circuitDecides) {
    throw channelConnectionInactive({ channel, reason: 'UNHEALTHY', connectionId: connection.id, healthStatus: health.healthStatus, circuitState: health.circuitState });
  }
  await assertNetworkAuthorized({ tenant, channel, connection }, transaction); // M9-D428: rede com token recusado precisa ser reautorizada (409 MKT_PROVIDER_AUTH_FAILED)
  return { id: connection.id, providerCode: connection.providerCode, family: meta.family };
}

module.exports = { resolveChannelConnection };
