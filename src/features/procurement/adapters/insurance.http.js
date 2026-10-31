'use strict';

const { IntegrationHttpClient } = require('../../integrations/http/IntegrationHttpClient');
const { readAdapterParams } = require('../../integrations/registry/adapters.params');

/**
 * Cliente HTTP do fluxo antigo de Seguros (sem connection): tempos de leitura e de escrita lidos dos parâmetros da empresa
 * (`integration.dispatch.timeout_ms.read` e `.write`) e UMA tentativa por chamada (M9-D216: quem repete é o Dispatch Service,
 * por classe de erro; operação que altera estado nunca é repetida às cegas, INT-005).
 */
async function insuranceHttpFor(tenant, transaction) {
  const params = await readAdapterParams(tenant, transaction);
  return new IntegrationHttpClient({ providerCode: 'insurance', timeouts: { readMs: params.readTimeoutMs, writeMs: params.writeTimeoutMs }, maxAttempts: 1 });
}

module.exports = { insuranceHttpFor };
