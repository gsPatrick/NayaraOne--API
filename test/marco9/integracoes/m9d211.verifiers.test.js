'use strict';

// Marco 9, M9-D211 — verificadores de assinatura e registro por fornecedor: puros, sem banco e sem rede.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { hmacSha256Hex, hmacSha256Base64, hmacWithTimestamp, registerVerifier, unregisterVerifier, verifierFor } = require('../../../src/features/integrations/webhooks/verifiers');
const { registerBuiltInAdapters } = require('../../../src/features/integrations/adapters');

const hmac = (segredo, ...partes) => { const h = crypto.createHmac('sha256', segredo); partes.forEach((p) => h.update(p)); return h.digest(); };
const DIR = path.join(__dirname, '../../../src/features/integrations/webhooks/verifiers');

test('webhook_assinatura_tempo_constante', () => {
  const fontes = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);
  const comparador = fontes.find(([f]) => f === 'safeEqual.js')[1];
  assert.match(comparador, /crypto\.timingSafeEqual\(/, 'a comparação usa timingSafeEqual');
  fontes.forEach(([f, texto]) => {
    const codigo = texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(codigo, /(assinatura|signature|recebido|obtido|esperado|expected|received)\w*\s*[!=]==?\s/i, `${f}: assinatura nunca é comparada com ===`);
    assert.doesNotMatch(codigo, /\.(equals|localeCompare)\(/, `${f}: nem por equals/localeCompare`);
  });
  const corpo = Buffer.from('{"a":1}');
  const v = hmacSha256Hex();
  assert.equal(v.verify({ rawBody: corpo, headers: { 'x-signature': 'ab' }, secret: 'k' }).ok, false, 'tamanho diferente é recusado sem lançar');
  assert.equal(v.verify({ rawBody: corpo, headers: { 'x-signature': 'zz'.repeat(32) }, secret: 'k' }).ok, false, 'não hexadecimal é recusado sem lançar');
});

test('verificador_hmac_hex_base64_e_com_horario', () => {
  const corpo = Buffer.from('{"id":"e1","type":"payment.paid"}');
  const hex = hmac('k', corpo).toString('hex');
  assert.equal(hex.length, 64);
  assert.equal(hmacSha256Hex().verify({ rawBody: corpo, headers: { 'x-signature': hex }, secret: 'k' }).ok, true);
  assert.equal(hmacSha256Hex().verify({ rawBody: corpo, headers: { 'x-signature': `sha256=${hex}` }, secret: 'k' }).ok, true);
  assert.equal(hmacSha256Hex({ header: 'x-webhook-signature' }).verify({ rawBody: corpo, headers: { 'x-webhook-signature': hex }, secret: 'k' }).ok, true);
  assert.equal(hmacSha256Hex().verify({ rawBody: Buffer.from('{"id":"e1","type":"payment.paid" }'), headers: { 'x-signature': hex }, secret: 'k' }).ok, false, 'um byte a mais muda tudo');
  assert.equal(hmacSha256Hex().verify({ rawBody: corpo, headers: { 'x-signature': hex }, secret: '' }).ok, false, 'sem segredo nunca passa');
  assert.equal(hmacSha256Base64().verify({ rawBody: corpo, headers: { 'x-signature': hmac('k', corpo).toString('base64') }, secret: 'k' }).ok, true);
  assert.equal(hmacSha256Base64().verify({ rawBody: corpo, headers: { 'x-signature': hmac('outro', corpo).toString('base64') }, secret: 'k' }).ok, false);

  // exemplo numérico da demanda: assinatura = HMAC_SHA256(k, "1767225600." + corpo) em hexadecimal
  const t = 1767225600;
  const esperado = hmac('k', `${t}.`, corpo).toString('hex');
  assert.equal(esperado.length, 64);
  const ts = hmacWithTimestamp();
  const bom = ts.verify({ rawBody: corpo, headers: { 'x-signature': `t=${t},v1=${esperado}` }, secret: 'k' });
  assert.deepEqual([bom.ok, bom.timestamp], [true, t], 'devolve o horário assinado para a conferência de replay');
  assert.equal(ts.verify({ rawBody: corpo, headers: { 'x-signature': `t=${t + 1},v1=${esperado}` }, secret: 'k' }).ok, false, 'o horário faz parte do que se assina');
  assert.equal(ts.verify({ rawBody: corpo, headers: { 'x-signature': `t=${t},v1=${'0'.repeat(64)},v1=${esperado}` }, secret: 'k' }).ok, true, 'várias v1 (rotação do fornecedor)');
  assert.equal(ts.verify({ rawBody: corpo, headers: { 'x-signature': `v1=${esperado}` }, secret: 'k' }).ok, false);
  assert.equal(ts.verify({ rawBody: Buffer.alloc(0), headers: { 'x-signature': `t=${t},v1=${esperado}` }, secret: 'k' }).ok, false);
});

test('verificador_registro_por_fornecedor', () => {
  registerBuiltInAdapters();
  ['messaging-sandbox', 'portal-sandbox', 'social-sandbox', 'signature-sandbox'].forEach((p) => assert.equal(verifierFor(p).name, 'hmacWithTimestamp', p));
  assert.equal(verifierFor('signature-alt-sandbox').name, 'hmacSha256Base64', 'signature-alt-sandbox: o segundo formato de assinatura (M9-D236)');
  ['bank-sandbox', 'signature-clicksign', 'signature-zapsign', 'financing-sandbox'].forEach((p) => assert.equal(verifierFor(p).name, 'hmacSha256Hex', p));
  const corpo = Buffer.from('{"event":{"name":"sign"}}');
  const clicksign = verifierFor('signature-clicksign').verify({ rawBody: corpo, headers: { 'content-hmac': `sha256=${hmac('k', corpo).toString('hex')}` }, secret: 'k' });
  assert.equal(clicksign.ok, true, 'o Clicksign assina no cabeçalho content-hmac');
  ['analytics-sandbox', 'fiscal-sandbox', 'financing-manual', 'insurance-sandbox', 'inexistente'].forEach((p) => assert.equal(verifierFor(p), null, `${p}: sem verificador, a rota responde 501`));
  const proprio = { name: 'proprio', verify: () => ({ ok: true, reason: null }) };
  registerVerifier('analytics-sandbox', proprio);
  assert.equal(verifierFor('analytics-sandbox'), proprio);
  unregisterVerifier('analytics-sandbox');
  assert.equal(verifierFor('analytics-sandbox'), null);
  assert.throws(() => registerVerifier('x', { name: 'sem-verify' }), /inválido/);
});
