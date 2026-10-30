'use strict';

const adapterRegistry = require('../../integrations/registry/adapterRegistry');

/**
 * Garante o adapter do fornecedor de assinatura no AdapterRegistry (M9-D236). O servidor registra todos no boot (adapters/index.js); este atalho serve a quem usa o Jurídico
 * sem o boot do servidor (scripts e testes de serviço): registra só o adapter do fornecedor pedido, com a mesma validação de contrato, e não faz nada se já estiver registrado.
 */
const CLASSES = () => ({
  'signature-sandbox': require('../../integrations').SignatureSandboxAdapter,
  'signature-alt-sandbox': require('../../integrations').SignatureAltSandboxAdapter,
  'signature-clicksign': require('../../integrations/adapters/legacy/signature.adapters').SignatureClicksignContractAdapter,
  'signature-zapsign': require('../../integrations/adapters/legacy/signature.adapters').SignatureZapSignContractAdapter,
});

function ensureAdapterRegistered(providerCode) {
  if (adapterRegistry.has(providerCode)) return;
  const Classe = CLASSES()[providerCode];
  if (Classe) adapterRegistry.register(Classe);
}

module.exports = { ensureAdapterRegistered };
