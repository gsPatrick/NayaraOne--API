'use strict';

/**
 * Providers que o seed do catálogo cadastra (Marco 9, M9-D201): um sandbox determinístico por família
 * (é o que o laboratório usa) e os fornecedores que o código já tinha. Quando a Nayara contratar um
 * fornecedor real, ele entra como linha nova + um adapter; o sandbox permanece.
 */
const { DEFAULT_CRITICALITY } = require('./catalog.domains');

const sandbox = (domain, code, displayName, capabilities) => ({
  code, displayName, domain, capabilities, supportedVersions: ['v1'], criticality: DEFAULT_CRITICALITY[domain], sandboxAvailable: true,
});

const SANDBOX_PROVIDERS = Object.freeze([
  sandbox('MESSAGING', 'messaging-sandbox', 'Mensageria (WhatsApp e atendimento) — sandbox', ['sendText', 'sendTemplate', 'sendMedia', 'getStatus']),
  sandbox('EMAIL', 'email-sandbox', 'E-mail — sandbox', ['sendEmail', 'getDeliveryStatus', 'receiveInbound']),
  sandbox('SITE', 'site-sandbox', 'Site — sandbox', ['publishPage', 'unpublishPage', 'getPageStatus']),
  sandbox('PORTAL', 'portal-sandbox', 'Portais imobiliários — sandbox', ['publishListing', 'updateListing', 'unpublishListing', 'getListingStatus']),
  sandbox('SIGNATURE', 'signature-sandbox', 'Assinatura digital — sandbox', ['createEnvelope', 'getEnvelope', 'cancelEnvelope', 'downloadSigned', 'verifyWebhook']),
  sandbox('BANK', 'bank-sandbox', 'Bancos, extratos e pagamentos — sandbox', ['submitPayment', 'getPaymentStatus', 'getStatement', 'verifyWebhook']),
  sandbox('INSURANCE', 'insurance-sandbox', 'Seguradoras e garantias — sandbox', ['quote', 'propose', 'getPolicy', 'getStatus']),
  // O sandbox de financiamento já verificava o webhook (assinatura HMAC) antes do catálogo: mantém verifyWebhook (DI-D201-3).
  sandbox('FINANCING', 'financing-sandbox', 'Financiamento e promotoras — sandbox', ['simulate', 'submitCase', 'getCaseStatus', 'uploadDocument', 'requestAppraisal', 'verifyWebhook']),
  sandbox('FISCAL', 'fiscal-sandbox', 'NFS-e e fiscal — sandbox', ['issueNfse', 'getNfseStatus', 'cancelNfse']),
  sandbox('SOCIAL', 'social-sandbox', 'Redes sociais e publicação — sandbox', ['publishPost', 'getPostStatus', 'deletePost']),
  sandbox('STORAGE', 'storage-sandbox', 'Armazenamento de objetos — sandbox', ['putObject', 'getObject', 'deleteObject', 'headObject']),
  sandbox('IDENTITY', 'identity-sandbox', 'Identidade e autenticação — sandbox', ['verifyToken', 'getUserInfo', 'revokeSession']),
  sandbox('AI', 'ai-sandbox', 'Modelos de IA — sandbox', ['generate', 'embed', 'transcribe', 'analyzeImage']),
  sandbox('ANALYTICS', 'analytics-sandbox', 'Analytics e monitoramento — sandbox', ['emitMetric', 'emitEvent', 'queryHealth']),
]);

/** Fornecedores que não são sandbox mas já existiam no código (fluxo manual assistido e Clicksign). */
const EXISTING_PROVIDERS = Object.freeze([
  {
    code: 'financing-manual', displayName: 'Financiamento — fluxo manual assistido', domain: 'FINANCING',
    capabilities: ['submitCase', 'getCaseStatus'], supportedVersions: ['v1'], criticality: DEFAULT_CRITICALITY.FINANCING, sandboxAvailable: false,
  },
  {
    code: 'signature-clicksign', displayName: 'Assinatura digital — Clicksign', domain: 'SIGNATURE',
    capabilities: ['createEnvelope', 'getEnvelope', 'cancelEnvelope', 'downloadSigned', 'verifyWebhook'], supportedVersions: ['v1'], criticality: DEFAULT_CRITICALITY.SIGNATURE, sandboxAvailable: false,
  },
  // M9-D232: três portais sandbox com mapping, versão e capacidades próprios (o exemplo do livro: A converte VENDA em SALE, B exige bathrooms, C não tem vídeo).
  ...[['portal-zap-sandbox', 'Portal A (estilo ZAP) — sandbox'], ['portal-vivareal-sandbox', 'Portal B (estilo Viva Real) — sandbox'], ['portal-olx-sandbox', 'Portal C (estilo OLX) — sandbox']]
    .map(([code, nome]) => ({ code, displayName: nome, domain: 'PORTAL', capabilities: ['publishListing', 'updateListing', 'unpublishListing', 'getListingStatus'], supportedVersions: ['v1'], criticality: DEFAULT_CRITICALITY.PORTAL, sandboxAvailable: true })),
  // M9-D237: o Santander (PIX e boleto por mTLS) que já existia no Financeiro entra no catálogo com o contrato do port BankAdapter.
  {
    code: 'bank-santander', displayName: 'Banco — Santander (PIX e boleto)', domain: 'BANK',
    capabilities: ['submitPayment', 'getPaymentStatus', 'getStatement', 'verifyWebhook'], supportedVersions: ['v1'], criticality: DEFAULT_CRITICALITY.BANK, sandboxAvailable: false,
  },
  // M9-D236: ZapSign (adapter que já existia no Jurídico) entra no catálogo; e o segundo fornecedor de laboratório que prova a troca de provider (formato de webhook diferente).
  {
    code: 'signature-zapsign', displayName: 'Assinatura digital — ZapSign', domain: 'SIGNATURE',
    capabilities: ['createEnvelope', 'getEnvelope', 'cancelEnvelope', 'downloadSigned', 'verifyWebhook'], supportedVersions: ['v1'], criticality: DEFAULT_CRITICALITY.SIGNATURE, sandboxAvailable: false,
  },
  {
    code: 'signature-alt-sandbox', displayName: 'Assinatura digital — sandbox alternativo (prova de troca de provider)', domain: 'SIGNATURE',
    capabilities: ['createEnvelope', 'getEnvelope', 'cancelEnvelope', 'downloadSigned', 'verifyWebhook'], supportedVersions: ['v1'], criticality: DEFAULT_CRITICALITY.SIGNATURE, sandboxAvailable: false,
  },
]);

/** Fornecedores reais de modelo de IA (M9-D011). Nascem sem conexão: só valem com conexão ACTIVE, que exige a referência do segredo. */
const aiReal = (code, displayName, capabilities) => ({
  code, displayName, domain: 'AI', capabilities, supportedVersions: ['v1'], criticality: DEFAULT_CRITICALITY.AI, sandboxAvailable: false,
  // M9-D229: o segundo fornecedor de mensageria de laboratório (formato de webhook diferente e sem sendMedia) que prova a troca de provider da M9-D221.
  {
    code: 'messaging-alt-sandbox', displayName: 'Mensageria — sandbox alternativo (prova de troca de provider)', domain: 'MESSAGING',
    capabilities: ['sendText', 'sendTemplate', 'getStatus'], supportedVersions: ['v1'], criticality: DEFAULT_CRITICALITY.MESSAGING, sandboxAvailable: false,
  },
});
const AI_REAL_PROVIDERS = Object.freeze([
  aiReal('anthropic', 'Modelos de IA — Anthropic', ['generate']),
  aiReal('openai', 'Modelos de IA — OpenAI', ['generate', 'embed']),
]);

const SEED_PROVIDERS = Object.freeze([...SANDBOX_PROVIDERS, ...EXISTING_PROVIDERS, ...AI_REAL_PROVIDERS]);

module.exports = { SANDBOX_PROVIDERS, EXISTING_PROVIDERS, AI_REAL_PROVIDERS, SEED_PROVIDERS };
