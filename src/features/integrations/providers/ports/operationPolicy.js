'use strict';

/**
 * Política de cada operação dos ports (Marco 9, M9-D214 3.1 item 6 e 3.3): fonte única da classe de risco e da forma de confirmação.
 *  - opClass DANGEROUS: cria efeito externo que não se desfaz ou se duplica ao repetir (pagamento, assinatura, publicação de anúncio,
 *    página ou post, emissão fiscal, proposta); SAFE: consulta, envio de mensagem e e-mail, remoção ou atualização idempotente.
 *  - confirmation ON_RESPONSE: a resposta basta quando traz status final (finalStatuses; null = qualquer resposta válida de consulta);
 *    ON_STATUS: só o status final por webhook assinado ou consulta de status confirma (HTTP 200 ou 202 de submissão nunca confirma).
 * `essential` (M9-D217): a operação atravessa o circuito aberto. Operação nova de um domínio sem linha aqui derruba o carregamento do port: a classe nunca fica implícita.
 */
const op = (opClass, confirmation = 'ON_RESPONSE', finalStatuses = null, essential = false) => Object.freeze({ opClass, confirmation, finalStatuses: finalStatuses ? Object.freeze([...finalStatuses]) : null, essential });
const SAFE = op('SAFE');
// Essencial (M9-D217 3.3): confirmação e consulta de pagamento e de assinatura em andamento atravessam o circuito aberto; marketing, sincronização de listagem e métricas esperam.
const ESSENCIAL = op('SAFE', 'ON_RESPONSE', null, true);
const PERIGOSA_POR_STATUS = op('DANGEROUS', 'ON_STATUS');
// Envio de mensagem é SAFE no livro ("envio de mensagem de status"); só vira CONFIRMED com status final e recurso externo, senão fica SUBMITTED.
const MENSAGEM = op('SAFE', 'ON_RESPONSE', ['DELIVERED', 'READ']);

const OPERATION_POLICY = Object.freeze({
  MESSAGING: Object.freeze({ sendText: MENSAGEM, sendTemplate: MENSAGEM, sendMedia: MENSAGEM, getStatus: SAFE }),
  EMAIL: Object.freeze({ sendEmail: op('SAFE', 'ON_RESPONSE', ['DELIVERED']), getDeliveryStatus: SAFE, receiveInbound: SAFE }),
  SITE: Object.freeze({ publishPage: PERIGOSA_POR_STATUS, unpublishPage: SAFE, getPageStatus: SAFE }),
  PORTAL: Object.freeze({ publishListing: PERIGOSA_POR_STATUS, updateListing: SAFE, unpublishListing: SAFE, getListingStatus: SAFE }),
  SIGNATURE: Object.freeze({ createEnvelope: PERIGOSA_POR_STATUS, getEnvelope: ESSENCIAL, cancelEnvelope: SAFE, verifyWebhook: SAFE, downloadSigned: SAFE }),
  BANK: Object.freeze({ submitPayment: PERIGOSA_POR_STATUS, getPaymentStatus: ESSENCIAL, getStatement: SAFE, verifyWebhook: SAFE }),
  INSURANCE: Object.freeze({ quote: SAFE, propose: PERIGOSA_POR_STATUS, getPolicy: SAFE, getStatus: SAFE }),
  FINANCING: Object.freeze({
    simulate: SAFE, submitCase: PERIGOSA_POR_STATUS, getCaseStatus: SAFE, uploadDocument: op('DANGEROUS'), requestAppraisal: PERIGOSA_POR_STATUS, verifyWebhook: SAFE, cancelCase: SAFE,
  }),
  FISCAL: Object.freeze({ issueNfse: PERIGOSA_POR_STATUS, getNfseStatus: SAFE, cancelNfse: SAFE }),
  SOCIAL: Object.freeze({ publishPost: PERIGOSA_POR_STATUS, getPostStatus: SAFE, deletePost: SAFE, findPostByKey: SAFE }),
  STORAGE: Object.freeze({ putObject: SAFE, getObject: SAFE, deleteObject: SAFE, headObject: SAFE, getSignedUrl: SAFE }),
  IDENTITY: Object.freeze({ verifyToken: SAFE, getUserInfo: SAFE, revokeSession: SAFE, listJwks: SAFE }),
  AI: Object.freeze({ generate: SAFE, embed: SAFE, transcribe: SAFE, analyzeImage: SAFE }),
  ANALYTICS: Object.freeze({ emitMetric: SAFE, emitEvent: SAFE, queryHealth: SAFE }),
});

module.exports = { OPERATION_POLICY };
