'use strict';

const adapterRegistry = require('../../integrations/registry/adapterRegistry');
const { findActiveByProvider, ensureSandboxConnection } = require('../../integrations/registry/connections.ensureSandbox');
const { getSetting } = require('../../settings/settings.service');
const AppError = require('../../../utils/AppError');
const { assertSandboxAllowed } = require('../adapters/resolveInsuranceAdapter');
const { createRealConnection } = require('./insurance.secrets');

/** `procurement.insurance_provider` (configuração da empresa) -> código do catálogo de integrações (M9-D238). */
const PROVIDER_CODES = Object.freeze({
  sandbox: 'insurance-sandbox', porto_seguro: 'insurance-porto-seguro', yelum: 'insurance-yelum', junto_seguros: 'insurance-junto-seguros', manual: 'insurance-manual',
});
const REAL = Object.freeze(['porto_seguro', 'yelum']);
const KEYS = Object.freeze(Object.fromEntries(Object.entries(PROVIDER_CODES).map(([chave, codigo]) => [codigo, chave])));

/** O valor de `procurement.insurance_provider` que corresponde ao código do catálogo (o que a apólice grava em `provider`). */
const providerKeyOf = (providerCode) => KEYS[providerCode] || providerCode;

/** Registra o adapter pedido quando o servidor não passou pelo boot (scripts e testes de serviço); o boot normal já registrou todos. */
function ensureAdapterRegistered(providerCode) {
  if (adapterRegistry.has(providerCode)) return;
  const { INSURANCE_ADAPTERS } = require('../../integrations/adapters/legacy/insurance.registry');
  const Classe = INSURANCE_ADAPTERS.find((A) => new A(null).providerCode() === providerCode);
  if (Classe) adapterRegistry.register(Classe);
}

/**
 * A connection de seguro da empresa (M9-D238): a do fornecedor escolhido em `procurement.insurance_provider`. Sandbox e fluxo manual ganham a connection sozinhos fora de produção.
 * Porto Seguro e Yelum usam a connection ATIVA ou, na primeira vez, a criada a partir das credenciais já configuradas (o segredo vai ao cofre e sai de tenant_settings). Credencial
 * incompleta falha fechado, como sempre (nunca cai no sandbox em silêncio). Junto Seguros não tem integração disponível.
 */
async function ensureInsuranceConnection(ctx, transaction) {
  const escolhido = await getSetting('procurement.insurance_provider', ctx, transaction, 'sandbox');
  const key = PROVIDER_CODES[escolhido] ? escolhido : 'sandbox';
  const providerCode = PROVIDER_CODES[key];
  ensureAdapterRegistered(providerCode);
  if (key === 'sandbox') assertSandboxAllowed();
  if (key === 'junto_seguros') {
    throw AppError.badRequest('O provedor de seguro "junto_seguros" está selecionado, mas não tem integração disponível — selecione o sandbox (homologação), o fluxo manual ou um provedor com credencial configurada.', 'PROCUREMENT_INSURANCE_PROVIDER_UNAVAILABLE');
  }
  if (REAL.includes(key)) {
    return (await findActiveByProvider(ctx, providerCode, transaction)) || createRealConnection(ctx, key, providerCode, transaction);
  }
  return ensureSandboxConnection(ctx, { providerCode, label: `Seguros: ${providerCode}` }, transaction);
}

module.exports = { ensureInsuranceConnection, ensureAdapterRegistered, PROVIDER_CODES, providerKeyOf };
