'use strict';

/**
 * Hosts que cada fornecedor aceita como endereço base (`config_json.baseUrl`), produção e sandbox (M9-D245, reabertura G2). Lista fechada no código do adaptador:
 * a empresa só acrescenta hosts pelo parâmetro `integration.egress.provider_hosts`, nunca pela política da conexão. Fornecedor fora do mapa não aceita endereço base próprio.
 */
const PROVIDER_BASE_HOSTS = Object.freeze({
  'signature-clicksign': Object.freeze(['app.clicksign.com', 'sandbox.clicksign.com']),
  'signature-zapsign': Object.freeze(['api.zapsign.com.br', 'sandbox.api.zapsign.com.br']),
});

const baseHostsOf = (providerCode) => [...(PROVIDER_BASE_HOSTS[String(providerCode)] || [])];

module.exports = { PROVIDER_BASE_HOSTS, baseHostsOf };
