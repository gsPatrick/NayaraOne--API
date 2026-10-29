'use strict';

/**
 * Adapters que já existiam, adaptados ao contrato IntegrationAdapter (M9-D209) e registrados no boot. Adapter novo de uma
 * família entra aqui (ou em sua própria demanda) e passa pela mesma validação de contrato.
 */
const registry = require('../registry/adapterRegistry');
const { FinancingSandboxContractAdapter, FinancingManualContractAdapter } = require('./legacy/financing.adapters');
const { BankSandboxContractAdapter } = require('./legacy/bank.adapters');
const { SignatureSandboxContractAdapter, SignatureClicksignContractAdapter } = require('./legacy/signature.adapters');
const { InsuranceSandboxContractAdapter } = require('./legacy/insurance.adapters');
const { FiscalSandboxContractAdapter } = require('./legacy/fiscal.adapters');

const BUILT_IN_ADAPTERS = Object.freeze([
  FinancingSandboxContractAdapter, FinancingManualContractAdapter, BankSandboxContractAdapter, SignatureSandboxContractAdapter,
  SignatureClicksignContractAdapter, InsuranceSandboxContractAdapter, FiscalSandboxContractAdapter,
]);

/** Registra todos; contrato inválido lança 500 INTEGRATION_ADAPTER_CONTRACT_INVALID (o boot não segue). Devolve a lista registrada. */
function registerBuiltInAdapters() {
  BUILT_IN_ADAPTERS.forEach((A) => registry.register(A));
  return registry.list();
}

module.exports = { registerBuiltInAdapters, BUILT_IN_ADAPTERS };
