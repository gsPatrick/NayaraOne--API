'use strict';

const { AdapterRegistry: adapterRegistry, listConnections, getServerEnvironment } = require('../../integrations');

/** O que a conexão diz sobre o provedor: região, retenção, contrato, só-laboratório e o que ele aceita receber (config_json, D011). */
function connectionPolicy(connection) {
  const c = connection.configJson || {};
  return {
    region: c.region || null,
    dataRetention: c.data_retention || null,
    contractRef: c.contract_ref || null,
    labOnly: c.lab_only === true,
    allowsConfidential: c.allowsConfidential === true,
    allowsRestricted: c.allowsRestricted === true,
  };
}

/** Conexões de IA ATIVAS da empresa no ambiente do servidor, cada uma com a instância do adapter já com `ctx` (RLS: transação do tenant). */
async function activeAiConnections(tenant, transaction) {
  const rows = await listConnections(tenant, { domain: 'AI', status: 'ACTIVE' }, transaction);
  const ambiente = getServerEnvironment();
  const doAmbiente = rows.filter((c) => c.environment === ambiente && adapterRegistry.has(c.providerCode));
  const lista = [];
  for (const connection of doAmbiente) {
    lista.push({ connection, policy: connectionPolicy(connection), adapter: await adapterRegistry.resolve(connection, tenant, transaction) });
  }
  return lista;
}

module.exports = { activeAiConnections, connectionPolicy };
