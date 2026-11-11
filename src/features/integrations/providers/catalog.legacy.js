'use strict';

/**
 * Providers que já existiam no código antes do catálogo (Marco 9, M9-D201, regra 4). Os adapters ficam onde
 * estão; esta tabela diz qual linha do catálogo cada um representa. O Correspondente continua falando
 * "sandbox" e "manual" (configuração, casos, URL do webhook); o catálogo fala "financing-sandbox" e
 * "financing-manual" (DI-D201-1): `toCatalogCode` e `toCorrespondentCode` fazem a ponte.
 */
const LEGACY_ADAPTERS = Object.freeze([
  { file: 'src/features/correspondent/adapters/FinancingProviderAdapter.js', className: 'SandboxFinancingProviderAdapter', providerCode: 'financing-sandbox' },
  { file: 'src/features/correspondent/adapters/FinancingProviderAdapter.js', className: 'ManualWorkflowFinancingProviderAdapter', providerCode: 'financing-manual' },
  { file: 'src/features/correspondent/adapters/NfseAdapter.js', className: 'SandboxNfseAdapter', providerCode: 'fiscal-sandbox' },
  { file: 'src/features/procurement/adapters/InsuranceAdapter.js', className: 'SandboxInsuranceAdapter', providerCode: 'insurance-sandbox' },
  { file: 'src/features/finance/adapters/BankAdapter.js', className: 'SandboxBankAdapter', providerCode: 'bank-sandbox' },
  { file: 'src/modules/legal/signatures/providers/sandbox.provider.js', className: 'SandboxSignatureAdapter', providerCode: 'signature-sandbox' },
  { file: 'src/modules/legal/signatures/providers/clicksign.provider.js', className: 'ClicksignSignatureAdapter', providerCode: 'signature-clicksign' },
]);

/** Código usado pelo Correspondente -> código do catálogo. */
const CORRESPONDENT_TO_CATALOG = Object.freeze({ sandbox: 'financing-sandbox', manual: 'financing-manual' });
const CATALOG_TO_CORRESPONDENT = Object.freeze(Object.fromEntries(Object.entries(CORRESPONDENT_TO_CATALOG).map(([k, v]) => [v, k])));

function toCatalogCode(code) {
  const c = String(code ?? '').trim().toLowerCase();
  return CORRESPONDENT_TO_CATALOG[c] || c;
}

function toCorrespondentCode(code) {
  const c = String(code ?? '').trim().toLowerCase();
  return CATALOG_TO_CORRESPONDENT[c] || c;
}

module.exports = { LEGACY_ADAPTERS, CORRESPONDENT_TO_CATALOG, toCatalogCode, toCorrespondentCode };
