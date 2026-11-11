'use strict';

const { SignatureAdapter } = require('../../providers/signature/signature.port');
const { ClicksignSignatureAdapter, ZapSignSignatureAdapter } = require('../../../../modules/legal/signatures/providers');
const { wrapLegacy, mapFrom, verifyOp, hmacVerify } = require('../legacyWrap');
const { signatureEvent, KINDS } = require('../../providers/signature/sandbox/signature.sandbox.event');
const { ContractVersion } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { assertConfiguredBaseUrl } = require('../../http/configUrl.policy');
const { baseHostsOf } = require('../../http/providerBaseHosts');

const STATUS = { PENDING: 'PENDING', SIGNED: 'SIGNER_SIGNED', CLOSED: 'COMPLETED', RUNNING: 'PENDING', DRAFT: 'PENDING', CANCELLED: 'CANCELED', CANCELED: 'CANCELED', COMPLETED: 'COMPLETED', VALID: 'VALID', INVALID: 'INVALID' };

/**
 * Pedido de envelope (M9-D236): `documentRef` é a versão do contrato (id), `documentSha256` o hash aprovado e `signers` as pessoas (com nome e e-mail do cadastro). O adapter
 * antigo precisa da versão e da transação da empresa (RLS), que o worker entrega em `meta.transaction`; o hash enviado precisa ser o da versão no banco.
 */
async function criarEnvelope(legacy, req, self, meta) {
  const transaction = meta && meta.transaction;
  const carregar = meta && typeof meta.loadContractVersion === 'function' ? meta.loadContractVersion : (id, t) => ContractVersion.findByPk(id, { transaction: t });
  const versao = await carregar(String(req.documentRef), transaction);
  if (!versao) throw AppError.notFound('Versão do contrato não encontrada para o envelope.', 'LEGAL_SIGNATURE_VERSION_NOT_FOUND');
  if (req.documentSha256 && versao.contentHash !== req.documentSha256) {
    throw AppError.conflict('A versão do contrato mudou depois do pedido: o hash enviado não é o da versão.', 'LEGAL_SIGNATURE_VERSION_HASH_CHANGED');
  }
  const r = await legacy.requestSignature(versao, req.signers.map((s) => (s && typeof s === 'object' ? s.personId : s)), transaction);
  const signers = Object.entries(r.externalSignatureIdsByPerson || {}).map(([personId, externalSignerId]) => ({ personId, externalSignerId }));
  return { externalResourceId: r.providerEnvelopeId, status: self.normalizeStatus('PENDING'), signers, raw: r };
}

const ops = {
  createEnvelope: criarEnvelope,
  getEnvelope: async (l, req, self) => { const r = await l.getStatus(req.externalResourceId); return { externalResourceId: r.providerEnvelopeId ?? req.externalResourceId, status: self.normalizeStatus(r.status), raw: r.raw }; },
  cancelEnvelope: async (l, req, self) => { const r = await l.cancel(req.externalResourceId); return { externalResourceId: r.providerEnvelopeId ?? req.externalResourceId, status: self.normalizeStatus(r.cancelled === false ? 'PENDING' : 'CANCELED'), raw: r.raw }; },
  downloadSigned: async (l, req, self) => {
    const r = await l.downloadSignedDocument(req.externalResourceId);
    return { externalResourceId: req.externalResourceId, status: self.normalizeStatus('COMPLETED'), document: r ? { buffer: r.buffer, fileName: r.fileName } : null, raw: null };
  },
  verifyWebhook: verifyOp((l, req) => hmacVerify(req.rawBody, req.headers, req.secret)),
};

/** Clicksign e ZapSign não consultam envelope pela chave de idempotência: a consulta recusa com o código de sempre e o envio incerto segue para a revisão humana (como nos bancos e seguradoras). */
const semConsultaPorChave = async () => { throw Object.assign(new Error('O provedor de assinatura não oferece consulta por chave de idempotência.'), { code: 'INTEGRATION_LOOKUP_UNSUPPORTED' }); };

const CAPABILITIES = ['createEnvelope', 'getEnvelope', 'cancelEnvelope', 'downloadSigned', 'verifyWebhook'];
const SCHEMA_EVENTO = Object.freeze({ type: 'object', required: ['event'], properties: { event: { type: 'object' } } });

/** Saúde sem rede: só confirma que a credencial abre no cofre. */
async function saudeCofre(ctx) {
  const t0 = Date.now();
  try { await ctx.secret('test-connection'); return { ok: true, latencyMs: Date.now() - t0, detail: 'Credencial lida do cofre; sem chamada de teste ao fornecedor.' }; } catch (e) { return { ok: false, latencyMs: Date.now() - t0, detail: 'Credencial indisponível no cofre.' }; }
}

/** Evidência que o Clicksign informa no evento "sign": horário do evento, e-mail do signatário e o método (e-mail) exigido nos requisitos do envelope. */
function eventoClicksign(payload) {
  const e = (payload && payload.event) || {};
  const signer = (e.data && e.data.signer) || {};
  const envelopeId = (e.data && e.data.envelope && e.data.envelope.id) || (payload.envelope && payload.envelope.id) || (payload.document && payload.document.key) || null;
  const KIND = { sign: KINDS.SIGNER_SIGNED, close: KINDS.ENVELOPE_COMPLETED, auto_close: KINDS.ENVELOPE_COMPLETED, cancel: KINDS.ENVELOPE_CANCELLED };
  const kind = KIND[e.name];
  if (!kind) return { eventType: 'integration.signature.event', resourceRef: envelopeId, externalStatus: null, idempotencyKey: null, data: { kind: null, externalEnvelopeId: envelopeId }, private: {} };
  return signatureEvent({
    kind, envelopeId, signerId: signer.key || null, signerEmail: signer.email || null, signerName: signer.name || null, signedAt: e.occurred_at || null, ip: signer.ip || null, userAgent: signer.user_agent || null, authMethod: 'email',
  });
}

/** Hosts de cada fornecedor (produção e sandbox): a URL base da conexão só vale se o host for um deles ou constar em `integration.egress.provider_hosts` (M9-D245). */
const CLICKSIGN_HOSTS = baseHostsOf('signature-clicksign');
const ZAPSIGN_HOSTS = baseHostsOf('signature-zapsign');

/** URL base da configuração da conexão, já conferida (https, host público, host da lista do fornecedor); sem URL, vale o padrão do adaptador. */
function baseUrlConfigurada(ctx, hostsDoFornecedor) {
  const baseUrl = ctx.connection.config?.baseUrl;
  if (baseUrl === undefined || baseUrl === null || baseUrl === '') return undefined;
  assertConfiguredBaseUrl({ baseUrl: String(baseUrl), allowedHosts: ctx.baseUrlHosts || hostsDoFornecedor, environment: ctx.connection.environment });
  return baseUrl;
}

/** signature-clicksign: o token vem do cofre (SecretStore) quando a primeira operação roda; nada de rede no healthCheck. */
const SignatureClicksignContractAdapter = wrapLegacy({
  Port: SignatureAdapter,
  className: 'SignatureClicksignContractAdapter',
  code: 'signature-clicksign',
  hosts: CLICKSIGN_HOSTS,
  capabilities: CAPABILITIES,
  makeLegacy: async (ctx) => {
    const segredo = await ctx.secret('dispatch');
    return new ClicksignSignatureAdapter({ apiToken: segredo.value.reveal(), baseUrl: baseUrlConfigurada(ctx, CLICKSIGN_HOSTS) });
  },
  mapper: mapFrom(STATUS),
  webhookHeader: 'content-hmac',
  health: saudeCofre,
  ops,
  schemas: { '*': { v1: SCHEMA_EVENTO } },
  derivesEventId: true,
  toInternalEvent: eventoClicksign,
  idempotentOps: [],
  lookups: { findByIdempotencyKey: semConsultaPorChave },
});

/** signature-zapsign: mesmo contrato do Clicksign sobre o adapter antigo do ZapSign (cabeçalho x-zapsign-signature, formato do evento ainda sem credencial real para confirmar). */
const SignatureZapSignContractAdapter = wrapLegacy({
  Port: SignatureAdapter,
  className: 'SignatureZapSignContractAdapter',
  code: 'signature-zapsign',
  hosts: ZAPSIGN_HOSTS,
  capabilities: CAPABILITIES,
  makeLegacy: async (ctx) => {
    const segredo = await ctx.secret('dispatch');
    return new ZapSignSignatureAdapter({ apiToken: segredo.value.reveal(), baseUrl: baseUrlConfigurada(ctx, ZAPSIGN_HOSTS) });
  },
  mapper: mapFrom(STATUS),
  webhookHeader: 'x-zapsign-signature',
  health: saudeCofre,
  ops,
  schemas: { '*': { v1: { type: 'object' } } },
  derivesEventId: true,
  toInternalEvent: (payload) => {
    const tipo = String((payload && (payload.event_type || payload.event)) || '').toLowerCase();
    const signer = (payload && payload.signer) || {};
    const envelopeId = (payload && (payload.doc_token || (payload.doc && payload.doc.token))) || null;
    const kind = { doc_signed: KINDS.SIGNER_SIGNED, signer_signed: KINDS.SIGNER_SIGNED, doc_closed: KINDS.ENVELOPE_COMPLETED, doc_cancelled: KINDS.ENVELOPE_CANCELLED }[tipo];
    if (!kind) return { eventType: 'integration.signature.event', resourceRef: envelopeId, externalStatus: null, idempotencyKey: null, data: { kind: null, externalEnvelopeId: envelopeId }, private: {} };
    return signatureEvent({ kind, envelopeId, signerId: signer.token || null, signerEmail: signer.email || null, signerName: signer.name || null, signedAt: payload.signed_at || null, ip: signer.ip || null, userAgent: signer.user_agent || null, authMethod: 'email' });
  },
  idempotentOps: [],
  lookups: { findByIdempotencyKey: semConsultaPorChave },
});

module.exports = { SignatureClicksignContractAdapter, SignatureZapSignContractAdapter };
