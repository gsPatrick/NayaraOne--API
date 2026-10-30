'use strict';

const adapterRegistry = require('../../integrations/registry/adapterRegistry');

/**
 * Garante os adapters do banco no AdapterRegistry (M9-D237). O servidor registra todos no boot (integrations/adapters/index.js); este atalho serve a quem paga sem o boot
 * do servidor (scripts e testes de serviço): registra só os de banco, com a mesma validação de contrato, e não faz nada se já estiverem registrados.
 */
function ensureBankAdaptersRegistered() {
  if (adapterRegistry.has('bank-sandbox') && adapterRegistry.has('bank-santander')) return;
  const { BankSandboxContractAdapter } = require('../../integrations/adapters/legacy/bank.adapters');
  const { BankSantanderContractAdapter } = require('../../integrations/adapters/legacy/bank.santander');
  [BankSandboxContractAdapter, BankSantanderContractAdapter].forEach((A) => { if (!adapterRegistry.has(new A(null).providerCode())) adapterRegistry.register(A); });
}

module.exports = { ensureBankAdaptersRegistered };
