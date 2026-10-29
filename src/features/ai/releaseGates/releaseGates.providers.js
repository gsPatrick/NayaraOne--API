'use strict';

const { providerRegistry } = require('../providers/ProviderRegistry');
const { readProviderParams } = require('../providers/providers.params');
const { activeAiConnections } = require('../providers/providerConnections');

/** Códigos dos provedores REAIS que a empresa usa: o padrão (se exige conexão) e todo provedor com conexão de IA ativa no ambiente do servidor. */
async function realProvidersInUse(ctx, transaction) {
  const codes = new Set();
  const { defaultProvider } = await readProviderParams(ctx, transaction);
  const klass = providerRegistry.classOf(defaultProvider);
  if (klass && klass.requiresConnection) codes.add(defaultProvider);
  for (const c of await activeAiConnections(ctx, transaction)) codes.add(c.connection.providerCode);
  return [...codes].sort();
}

module.exports = { realProvidersInUse };
