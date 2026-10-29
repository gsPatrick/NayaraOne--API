'use strict';

const { getSetting } = require('../../settings/settings.service');
const adapterRegistry = require('../../integrations/registry/adapterRegistry');
const { catalogLegacy: { toCatalogCode } } = require('../../integrations');
const { ensureFinancingConnection } = require('../dispatch/financingConnection');
const { FinancingSandboxContractAdapter, FinancingManualContractAdapter } = require('../../integrations/adapters/legacy/financing.adapters');

// Desde o Marco 9 (M9-D240) o adapter do Correspondente vem do registro único de integrações (AdapterRegistry): o fornecedor é uma connection FINANCING da empresa e
// o adapter é o do contrato (`financing-sandbox`, `financing-manual`). O Correspondente continua falando com a interface original (simulate, submitCase, getCaseStatus,
// uploadDocument, requestAppraisal, cancelCase, findSubmissionByKey, normalizeProviderStatus e verifyWebhook): é o objeto antigo que o adapter do contrato embrulha.
// Mesmo padrão de antes: ausência de configuração nunca quebra o fluxo de negócio (sandbox é o padrão), mas provider desconhecido em produção é erro de configuração.
const LEGACY_CODES = Object.freeze(['sandbox', 'manual']);

/** O registro é preenchido no boot da API (registerBuiltInAdapters); processos que não sobem a API (jobs avulsos, testes) registram aqui os dois do financiamento. Idempotente. */
function ensureFinancingAdapters() {
  [FinancingSandboxContractAdapter, FinancingManualContractAdapter].forEach((A) => {
    if (!adapterRegistry.has(new A(null).providerCode())) adapterRegistry.register(A);
  });
}

async function resolveFinancingProviderAdapter(tenant, transaction) {
  const provider = await getSetting('correspondent.financing_provider', tenant, transaction, 'sandbox');
  // Qualquer outro valor (incluindo nomes de banco ainda não implementados) cai no sandbox — nunca tenta adivinhar uma integração que não existe de verdade.
  // Em produção isso seria um "banco" que aprova sozinho, então lá um provider desconhecido é erro de configuração.
  if (provider !== 'manual' && provider !== 'sandbox' && process.env.DEPLOY_ENVIRONMENT === 'production') {
    throw new Error(`Provider de financiamento "${provider}" não está implementado neste ambiente.`);
  }
  const codigo = provider === 'manual' ? 'manual' : 'sandbox';
  ensureFinancingAdapters();
  const connection = await ensureFinancingConnection(tenant, codigo, transaction);
  const adapter = await adapterRegistry.resolve(connection, tenant, transaction);
  return adapter.legacyAdapterSync();
}

// Resolução por CÓDIGO de provider (não por empresa) — usada pelo roteamento do webhook ("POST /webhooks/financing/:provider"), que recebe o provider na própria URL e
// precisa do adapter ANTES de saber a empresa. É a instância do registro (sem connection): só as operações puras (assinatura e mapa de status) saem daqui.
// O sandbox aprova sozinho: em produção/staging ele não existe (um caso sandbox lá seria um "banco" falso).
function resolveFinancingProviderAdapterByCode(providerCode) {
  const codigo = String(providerCode || '').toLowerCase();
  if (!LEGACY_CODES.includes(codigo)) return null;
  ensureFinancingAdapters();
  if (codigo === 'sandbox' && (['production', 'staging'].includes(process.env.DEPLOY_ENVIRONMENT) || process.env.NODE_ENV === 'production')) return null;
  const adapter = adapterRegistry.instantiate(toCatalogCode(codigo));
  return adapter && adapter.legacyAdapterSync ? adapter.legacyAdapterSync() : null;
}

function listFinancingProviderCodes() {
  return [...LEGACY_CODES];
}

module.exports = { resolveFinancingProviderAdapter, resolveFinancingProviderAdapterByCode, listFinancingProviderCodes };
