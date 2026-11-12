'use strict';

const crypto = require('node:crypto');

const ALG = 'HMAC-SHA256';
const SIGNED = ['conclusion', 'criteria', 'commit', 'generated_at', 'report_id', 'company_id', 'dirty'];
const MIN_KEY = 16;

/** Chave de assinatura do relatório exportado: `MIGRATION_DRY3_SIGNING_KEY` do ambiente (nunca versionada; a mesma no laboratório do ensaio e no ambiente do GO). */
const signingKey = () => {
  const key = String(process.env.MIGRATION_DRY3_SIGNING_KEY || '');
  return key.length >= MIN_KEY ? key : null;
};

// JSON canônico (chaves em ordem) para a assinatura não depender da ordem dos campos. Iterativo desde a rodada 7 (DI-M9R-18).
const { canonicalJson: canonical } = require('../../../utils/canonicalJson');

const payload = (body) => canonical(SIGNED.reduce((acc, field) => ({ ...acc, [field]: body[field] }), {}));
const mac = (body, key) => crypto.createHmac('sha256', key).update(payload(body)).digest('hex');

/** Assinatura do relatório (M9-D908 §3.4): sem chave configurada devolve null e o relatório sai sem assinatura (o GO não o aceita). */
function sign(body) {
  const key = signingKey();
  return key ? { signature: mac(body, key), signature_alg: ALG } : null;
}

/** Confere a assinatura de um relatório lido do arquivo: { ok, reason }. Edição à mão de qualquer campo assinado invalida. */
function verify(body) {
  const key = signingKey();
  if (!key) return { ok: false, reason: 'KEY_MISSING' };
  if (!body || typeof body.signature !== 'string' || body.signature_alg !== ALG) return { ok: false, reason: 'UNSIGNED' };
  const expected = Buffer.from(mac(body, key), 'hex');
  const given = Buffer.from(body.signature, 'hex');
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? { ok: true } : { ok: false, reason: 'SIGNATURE_MISMATCH' };
}

module.exports = { sign, verify, signingKey, ALG, SIGNED };
