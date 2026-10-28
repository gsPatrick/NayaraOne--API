'use strict';

/**
 * Catálogo das 14 famílias de integração do livro (Marco 9, seção 3 "Catálogo inicial de integrações").
 * Fonte de verdade da lista de capabilities permitidas por domínio e da criticidade padrão. A lista é
 * usada pela validação do cadastro de fornecedores (providers.service) e pelos testes.
 *
 * Capabilities mínimas: as da tabela da demanda M9-D201. As operações extras (`downloadSigned`, `findPostByKey`,
 * `cancelCase`, `getSignedUrl`, `listJwks`, `verifyWebhook` do financiamento) são as que os ports de outras
 * demandas usam (D236, D239, D240, D242); entram aqui para o boot e a validação as aceitarem.
 */
const DOMAIN_CAPABILITIES = Object.freeze({
  MESSAGING: Object.freeze(['sendText', 'sendTemplate', 'sendMedia', 'getStatus']),
  EMAIL: Object.freeze(['sendEmail', 'getDeliveryStatus', 'receiveInbound']),
  SITE: Object.freeze(['publishPage', 'unpublishPage', 'getPageStatus']),
  PORTAL: Object.freeze(['publishListing', 'updateListing', 'unpublishListing', 'getListingStatus']),
  SIGNATURE: Object.freeze(['createEnvelope', 'getEnvelope', 'cancelEnvelope', 'verifyWebhook', 'downloadSigned']),
  BANK: Object.freeze(['submitPayment', 'getPaymentStatus', 'getStatement', 'verifyWebhook']),
  INSURANCE: Object.freeze(['quote', 'propose', 'getPolicy', 'getStatus']),
  FINANCING: Object.freeze(['simulate', 'submitCase', 'getCaseStatus', 'uploadDocument', 'requestAppraisal', 'verifyWebhook', 'cancelCase']),
  FISCAL: Object.freeze(['issueNfse', 'getNfseStatus', 'cancelNfse']),
  SOCIAL: Object.freeze(['publishPost', 'getPostStatus', 'deletePost', 'findPostByKey']),
  STORAGE: Object.freeze(['putObject', 'getObject', 'deleteObject', 'headObject', 'getSignedUrl']),
  IDENTITY: Object.freeze(['verifyToken', 'getUserInfo', 'revokeSession', 'listJwks']),
  AI: Object.freeze(['generate', 'embed', 'transcribe', 'analyzeImage']),
  ANALYTICS: Object.freeze(['emitMetric', 'emitEvent', 'queryHealth']),
});

/** Nome da família como o livro a escreve (tela de Integrações). */
const DOMAIN_LABELS = Object.freeze({
  MESSAGING: 'WhatsApp e atendimento',
  EMAIL: 'E-mail',
  SITE: 'Site',
  PORTAL: 'Portais imobiliários',
  SIGNATURE: 'Assinatura digital',
  BANK: 'Bancos, extratos e pagamentos',
  INSURANCE: 'Seguradoras e garantias',
  FINANCING: 'Financiamento e promotoras',
  FISCAL: 'NFS-e e fiscal',
  SOCIAL: 'Redes sociais e publicação',
  STORAGE: 'Armazenamento de objetos',
  IDENTITY: 'Identidade e autenticação',
  AI: 'Modelos de IA',
  ANALYTICS: 'Analytics e monitoramento',
});

/**
 * Criticidade padrão (o livro não a fixa; regra inferida na demanda M9-D201 seção 3.1). O administrador a
 * muda por família em `integration.catalog.criticality.<domínio>` (catalog.settings.js).
 */
const DEFAULT_CRITICALITY = Object.freeze({
  MESSAGING: 'HIGH', EMAIL: 'MEDIUM', SITE: 'MEDIUM', PORTAL: 'MEDIUM', SIGNATURE: 'CRITICAL', BANK: 'CRITICAL',
  INSURANCE: 'HIGH', FINANCING: 'CRITICAL', FISCAL: 'HIGH', SOCIAL: 'LOW', STORAGE: 'HIGH', IDENTITY: 'CRITICAL',
  AI: 'MEDIUM', ANALYTICS: 'LOW',
});

const DOMAINS = Object.freeze(Object.keys(DOMAIN_CAPABILITIES));

module.exports = { DOMAINS, DOMAIN_CAPABILITIES, DOMAIN_LABELS, DEFAULT_CRITICALITY };
