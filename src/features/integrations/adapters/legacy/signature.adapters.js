'use strict';

const { SignatureAdapter } = require('../../providers/signature/signature.port');
const { SandboxSignatureAdapter, ClicksignSignatureAdapter } = require('../../../legal/adapters/SignatureAdapter');
const { wrapLegacy, mapFrom, COMPLETED, verifyOp, hmacVerify } = require('../legacyWrap');

const STATUS = { PENDING: 'PENDING', SIGNED: 'SIGNED', CLOSED: 'SIGNED', RUNNING: 'PENDING', CANCELLED: 'CANCELED', CANCELED: 'CANCELED', COMPLETED, VALID: 'VALID', INVALID: 'INVALID' };

const ops = {
  createEnvelope: async (l, req, self) => {
    const r = await l.requestSignature(req.documentRef, req.signers, undefined);
    return { externalResourceId: r.providerEnvelopeId, status: self.normalizeStatus('PENDING'), raw: r };
  },
  getEnvelope: async (l, req, self) => { const r = await l.getStatus(req.externalResourceId); return { externalResourceId: r.providerEnvelopeId ?? req.externalResourceId, status: self.normalizeStatus(r.status), raw: r.raw }; },
  cancelEnvelope: async (l, req, self) => { const r = await l.cancel(req.externalResourceId); return { externalResourceId: r.providerEnvelopeId ?? req.externalResourceId, status: self.normalizeStatus(r.cancelled === false ? 'PENDING' : 'CANCELED'), raw: r.raw }; },
  downloadSigned: async (l, req) => { const r = await l.downloadSignedDocument(req.externalResourceId); return { externalResourceId: req.externalResourceId, status: COMPLETED, raw: r }; },
  verifyWebhook: verifyOp((l, req) => hmacVerify(req.rawBody, req.headers, req.secret)),
};

/** signature-sandbox: assinatura simulada (sem rede). */
const SignatureSandboxContractAdapter = wrapLegacy({
  Port: SignatureAdapter,
  className: 'SignatureSandboxContractAdapter',
  code: 'signature-sandbox',
  capabilities: ['createEnvelope', 'getEnvelope', 'cancelEnvelope', 'verifyWebhook'],
  makeLegacy: () => new SandboxSignatureAdapter(),
  mapper: mapFrom(STATUS),
  ops,
});

/** signature-clicksign: o token vem do cofre (SecretStore) quando a primeira operação roda; nada de rede no healthCheck. */
const SignatureClicksignContractAdapter = wrapLegacy({
  Port: SignatureAdapter,
  className: 'SignatureClicksignContractAdapter',
  code: 'signature-clicksign',
  capabilities: ['createEnvelope', 'getEnvelope', 'cancelEnvelope', 'verifyWebhook'],
  makeLegacy: async (ctx) => {
    const segredo = await ctx.secret('dispatch');
    return new ClicksignSignatureAdapter({ apiToken: segredo.value.reveal(), baseUrl: ctx.connection.config?.baseUrl });
  },
  mapper: mapFrom(STATUS),
  health: async (ctx) => {
    const t0 = Date.now();
    try { await ctx.secret('test-connection'); return { ok: true, latencyMs: Date.now() - t0, detail: 'Credencial lida do cofre; sem chamada de teste ao fornecedor.' }; } catch (e) { return { ok: false, latencyMs: Date.now() - t0, detail: 'Credencial indisponível no cofre.' }; }
  },
  ops,
});

module.exports = { SignatureSandboxContractAdapter, SignatureClicksignContractAdapter };
