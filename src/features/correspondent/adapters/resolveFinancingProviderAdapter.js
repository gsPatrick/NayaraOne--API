'use strict';

const { getSetting } = require('../../settings/settings.service');
const { isSandboxBlocked } = require('../../../utils/sandboxPolicy');
const {
  SandboxFinancingProviderAdapter,
  ManualWorkflowFinancingProviderAdapter,
} = require('./FinancingProviderAdapter');

// Mesmo padrão exato de resolveInsuranceAdapter.js/resolveBankAdapter.js: fallback seguro pro
// Sandbox sempre que não houver provider real configurado — ausência de configuração NUNCA
// quebra o fluxo de negócio. Nenhum banco real está integrado ainda nesta Fase 0 (só a
// interface/contrato está pronta); quando a Nayara formalizar parceria com um banco/financeira
// (ver memória do projeto sobre contratos de produção ficarem a cargo da Nayara), um adapter
// novo entra aqui do mesmo jeito que Porto Seguro/Yelum entraram em resolveInsuranceAdapter.js.
async function resolveFinancingProviderAdapter(tenant, transaction) {
  const provider = await getSetting('correspondent.financing_provider', tenant, transaction, 'sandbox');

  if (provider === 'manual') {
    return new ManualWorkflowFinancingProviderAdapter();
  }

  // Qualquer outro valor (incluindo nomes de banco ainda não implementados) cai no sandbox —
  // nunca tenta adivinhar uma integração que não existe de verdade. Em produção isso seria um
  // "banco" que aprova sozinho, então lá um provider desconhecido é erro de configuração.
  if (provider !== 'sandbox' && process.env.DEPLOY_ENVIRONMENT === 'production') {
    throw new Error(`Provider de financiamento "${provider}" não está implementado neste ambiente.`);
  }
  return new SandboxFinancingProviderAdapter();
}

// Registry por CÓDIGO de provider (não por tenant/settings) — usado especificamente pelo
// roteamento de webhook ("POST /webhooks/financing/:provider"), que recebe o provider na própria
// URL e precisa resolver o adapter certo ANTES de saber a qual tenant o caso pertence (o tenant
// só é descoberto depois, pelo financing_case vinculado ao external_case_id — mesmo padrão do
// webhook de seguro em insurance.controller.js, que resolve a submission antes do tenant).
// "Registry resolve adapter" — Caderno Técnico, Marco 8, seção Webhook.
const FINANCING_PROVIDER_REGISTRY = {
  // O sandbox aprova sozinho: em produção real não existe (um caso sandbox lá seria um "banco" falso).
  // Em desenvolvimento, CI e homologação ele fica disponível (ver utils/sandboxPolicy.js).
  sandbox: () => (isSandboxBlocked() ? null : new SandboxFinancingProviderAdapter()),
  manual: () => new ManualWorkflowFinancingProviderAdapter(),
};

function resolveFinancingProviderAdapterByCode(providerCode) {
  const factory = FINANCING_PROVIDER_REGISTRY[String(providerCode || '').toLowerCase()];
  if (!factory) return null;
  return factory() || null;
}

function listFinancingProviderCodes() {
  return Object.keys(FINANCING_PROVIDER_REGISTRY);
}

module.exports = { resolveFinancingProviderAdapter, resolveFinancingProviderAdapterByCode, listFinancingProviderCodes };
