'use strict';

const { IntegrationConnection, IntegrationProvider } = require('../../../models');
const { getServerEnvironment } = require('../registry/registry.helpers');
const { getCurrentHealth } = require('../health/healthQuery');

/**
 * Estado do provedor EXTERNO de identidade da empresa (M9-D242 3.2): `configured` = há connection (ativa, pausada ou com credencial recusada) de um fornecedor da família
 * IDENTITY que não é o `identity-local`; `available` = alguma connection ACTIVE com o circuito fechado e a saúde fora de DOWN. Sem nenhum fornecedor externo, o
 * sistema usa só a autenticação própria (o estado normal de hoje) e nada é de contingência.
 */
async function externalIdentityState(tenant, transaction) {
  const providers = await IntegrationProvider.findAll({ where: { domain: 'IDENTITY' }, attributes: ['code'], transaction });
  const externos = providers.map((p) => p.code).filter((c) => c !== 'identity-local');
  if (!externos.length) return { configured: false, available: true, reason: null, connections: [] };
  const conexoes = await IntegrationConnection.findAll({
    where: { companyId: tenant.companyId, environment: getServerEnvironment(), status: ['ACTIVE', 'PAUSED', 'AUTH_FAILED'], providerCode: externos }, order: [['created_at', 'ASC']], transaction,
  });
  if (!conexoes.length) return { configured: false, available: true, reason: null, connections: [] };
  const ativas = conexoes.filter((c) => c.status === 'ACTIVE');
  if (!ativas.length) return { configured: true, available: false, reason: 'NO_ACTIVE_CONNECTION', connections: conexoes };
  const saude = [];
  for (const c of ativas) saude.push({ c, h: await getCurrentHealth(c.id, tenant, transaction) });
  const de = saude.filter((s) => s.h.circuitState !== 'OPEN' && s.h.healthStatus !== 'DOWN');
  if (de.length) return { configured: true, available: true, reason: null, connections: de.map((s) => s.c) };
  return { configured: true, available: false, reason: saude.some((s) => s.h.circuitState === 'OPEN') ? 'CIRCUIT_OPEN' : 'HEALTH_DOWN', connections: ativas };
}

module.exports = { externalIdentityState };
