'use strict';

/**
 * Política de cada operação dos ports (Marco 9, M9-D214 3.1 item 6 e 3.3): fonte única da classe de risco e da forma de confirmação.
 *  - opClass DANGEROUS: cria efeito externo que não se desfaz ou se duplica ao repetir (pagamento, assinatura, publicação de anúncio,
 *    página ou post, emissão fiscal, proposta); SAFE: consulta, envio de mensagem e e-mail, remoção ou atualização idempotente.
 *  - confirmation ON_RESPONSE: a resposta basta quando traz status final (finalStatuses; null = qualquer resposta válida de consulta);
 *    ON_STATUS: só o status final por webhook assinado ou consulta de status confirma (HTTP 200 ou 202 de submissão nunca confirma).
 * `reconcileStrategy` (M9-D215, só em operação DANGEROUS): como o motor descobre, depois de um timeout, se o fornecedor executou a operação. Três
 *  consultas, nesta ordem: `key` (método do adapter que devolve o recurso criado com a chave de idempotência), `status` (operação de consulta do
 *  próprio port, chamada com o id externo) e `reference` (método que busca pela referência de negócio). Webhook que chega resolve por fora.
 * `safeProbe` (M9-D250): consulta inócua, sem campo obrigatório, que o teste de conexão pode executar; nenhuma operação mutável carrega a marca.
 * `essential` (M9-D217): a operação atravessa o circuito aberto. Operação nova de um domínio sem linha aqui derruba o carregamento do port: a classe nunca fica implícita.
 */
const op = (opClass, confirmation = 'ON_RESPONSE', finalStatuses = null, essential = false, reconcileStrategy = null) => Object.freeze({
  opClass, confirmation, finalStatuses: finalStatuses ? Object.freeze([...finalStatuses]) : null, essential, reconcileStrategy: reconcileStrategy ? Object.freeze({ key: null, status: null, reference: null, ...reconcileStrategy }) : null,
});
const GENERICA = Object.freeze({ key: 'findByIdempotencyKey', reference: 'findByReference' });
/** Operação perigosa confirmada por status final, com as consultas de reconciliação (a de status é a operação de consulta do port). */
const perigosa = (statusOp, extra = {}) => op('DANGEROUS', 'ON_STATUS', null, false, { ...GENERICA, status: statusOp, ...extra });
const SAFE = op('SAFE');
// Consulta SEM nenhum campo obrigatório e sem efeito (M9-D250): o teste de conexão pode chamá-la de verdade, com pedido vazio, para provar que a credencial abre a porta.
const LEITURA_INOCUA = Object.freeze({ ...SAFE, safeProbe: true });
// Essencial (M9-D217 3.3): confirmação e consulta de pagamento e de assinatura em andamento atravessam o circuito aberto; marketing, sincronização de listagem e métricas esperam.
const ESSENCIAL = op('SAFE', 'ON_RESPONSE', null, true);
// Envio de mensagem é SAFE no livro ("envio de mensagem de status"); só vira CONFIRMED com status final e recurso externo, senão fica SUBMITTED.
const MENSAGEM = op('SAFE', 'ON_RESPONSE', ['DELIVERED', 'READ']);

const OPERATION_POLICY = Object.freeze({
  MESSAGING: Object.freeze({ sendText: MENSAGEM, sendTemplate: MENSAGEM, sendMedia: MENSAGEM, getStatus: SAFE }),
  EMAIL: Object.freeze({ sendEmail: op('SAFE', 'ON_RESPONSE', ['DELIVERED']), getDeliveryStatus: SAFE, receiveInbound: SAFE }),
  SITE: Object.freeze({ publishPage: perigosa('getPageStatus'), unpublishPage: SAFE, getPageStatus: SAFE }),
  PORTAL: Object.freeze({ publishListing: perigosa('getListingStatus'), updateListing: SAFE, unpublishListing: SAFE, getListingStatus: SAFE }),
  SIGNATURE: Object.freeze({ createEnvelope: perigosa('getEnvelope'), getEnvelope: ESSENCIAL, cancelEnvelope: SAFE, verifyWebhook: SAFE, downloadSigned: SAFE }),
  BANK: Object.freeze({ submitPayment: perigosa('getPaymentStatus'), getPaymentStatus: ESSENCIAL, getStatement: SAFE, verifyWebhook: SAFE }),
  INSURANCE: Object.freeze({ quote: SAFE, propose: perigosa('getStatus'), getPolicy: SAFE, getStatus: SAFE, submitClaim: perigosa('getStatus'), verifyWebhook: SAFE }),
  FINANCING: Object.freeze({
    simulate: SAFE, submitCase: perigosa('getCaseStatus'), getCaseStatus: SAFE, uploadDocument: op('DANGEROUS'), requestAppraisal: perigosa('getCaseStatus'), verifyWebhook: SAFE, cancelCase: SAFE,
  }),
  FISCAL: Object.freeze({ issueNfse: perigosa('getNfseStatus'), getNfseStatus: SAFE, cancelNfse: SAFE }),
  SOCIAL: Object.freeze({ publishPost: perigosa('getPostStatus', { key: 'findPostByKey' }), getPostStatus: SAFE, deletePost: perigosa('getPostStatus', { key: null, reference: null }), findPostByKey: SAFE }),
  STORAGE: Object.freeze({ putObject: SAFE, getObject: SAFE, deleteObject: SAFE, headObject: SAFE, getSignedUrl: SAFE }),
  IDENTITY: Object.freeze({ verifyToken: SAFE, getUserInfo: SAFE, revokeSession: SAFE, listJwks: LEITURA_INOCUA }),
  AI: Object.freeze({ generate: SAFE, embed: SAFE, transcribe: SAFE, analyzeImage: SAFE }),
  ANALYTICS: Object.freeze({ emitMetric: SAFE, emitEvent: SAFE, queryHealth: LEITURA_INOCUA }),
});

module.exports = { OPERATION_POLICY };
