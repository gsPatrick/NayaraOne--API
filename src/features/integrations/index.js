'use strict';

/**
 * API pública do módulo de integrações (M9-D210 3.1). Quem está fora de src/features/integrations importa SÓ daqui o que
 * vem de providers/** (catálogo, conversão de códigos, roteador do catálogo) e o contrato IntegrationAdapter (o adapter
 * de modelo de IA da NAY, src/features/ai/providers). O teste de arquitetura reprova qualquer atalho para dentro de providers/.
 * As exportações são preguiçosas: carregar o barrel não puxa o módulo inteiro nem cria ciclo com o serviço de configurações.
 * O DispatchService entra aqui com a M9-D214 e o roteador de webhooks com a M9-D211.
 */
const lazy = (carregar) => {
  let valor;
  let pronto = false;
  return () => {
    if (!pronto) { valor = carregar(); pronto = true; }
    return valor;
  };
};

const api = {};
const expor = (nome, carregar) => {
  const obter = lazy(carregar);
  Object.defineProperty(api, nome, { enumerable: true, get: obter });
};

expor('IntegrationAdapter', () => require('./registry/IntegrationAdapter').IntegrationAdapter);
expor('AiAdapter', () => require('./providers/ai/ai.port').AiAdapter);
expor('classifyHttpError', () => require('./registry/classifyHttpError').classifyHttpError);
expor('listConnections', () => require('./registry/connections.service').listConnections);
expor('getServerEnvironment', () => require('./registry/registry.helpers').getServerEnvironment);
expor('AdapterRegistry', () => require('./registry/adapterRegistry'));
expor('IntegrationHttpClient', () => require('./http/IntegrationHttpClient').IntegrationHttpClient);
expor('webhooks', () => require('./webhooks'));
expor('catalogRouter', () => require('./providers/catalog.routes'));
expor('CATALOG_SETTINGS_SCHEMA', () => require('./providers/catalog.settings').CATALOG_SETTINGS_SCHEMA);
expor('catalogLegacy', () => require('./providers/catalog.legacy'));

module.exports = api;
