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
expor('AnalyticsAdapter', () => require('./providers/analytics/analytics.port').AnalyticsAdapter);
expor('analytics', () => require('./analytics'));
expor('resolveAiMode', () => require('./providers/ai/ai.degrade').resolveAiMode);
expor('withAiFallback', () => require('./providers/ai/ai.degrade').withAiFallback);
expor('getAiContingencyCount', () => require('./providers/ai/ai.degrade').getAiContingencyCount);
expor('classifyHttpError', () => require('./registry/classifyHttpError').classifyHttpError);
expor('listConnections', () => require('./registry/connections.service').listConnections);
expor('getServerEnvironment', () => require('./registry/registry.helpers').getServerEnvironment);
expor('AdapterRegistry', () => require('./registry/adapterRegistry'));
expor('IntegrationHttpClient', () => require('./http/IntegrationHttpClient').IntegrationHttpClient);
expor('webhooks', () => require('./webhooks'));
expor('readCircuitState', () => require('./health').readCircuitState);
expor('SignatureSandboxAdapter', () => require('./providers/signature/sandbox/signature-sandbox.adapter').SignatureSandboxAdapter);
expor('SignatureAltSandboxAdapter', () => require('./providers/signature/sandbox/signature-alt-sandbox.adapter').SignatureAltSandboxAdapter);
expor('STORAGE_RESERVED_SUFFIX', () => require('./providers/storage/storage.key').RESERVED_SUFFIX);
expor('messagingStatus', () => require('./providers/messaging/messaging.status'));
expor('MESSAGING_EVENT_KINDS', () => require('./providers/messaging/messaging.event').KINDS);
expor('catalogRouter', () => require('./providers/catalog.routes'));
expor('CATALOG_SETTINGS_SCHEMA', () => require('./providers/catalog.settings').CATALOG_SETTINGS_SCHEMA);
expor('catalogLegacy', () => require('./providers/catalog.legacy'));
expor('compromiseDomainConnections', () => require('./registry/connections.compromise').compromiseDomainConnections); // M9-D433: conta comprometida
expor('urlProbe', () => require('./http/ssrf/ssrfProbe')); // M9-D433: destino público e redirecionamento (Marketing)

module.exports = api;
