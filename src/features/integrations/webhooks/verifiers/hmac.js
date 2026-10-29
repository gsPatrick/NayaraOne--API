'use strict';

const { safeEqual, digest, hexToBuffer, headerText } = require('./safeEqual');

/**
 * Verificadores prontos (M9-D211 3.3). Interface WebhookVerifier: { name, verify({ rawBody, headers, secret, now }) -> { ok, reason, eventId?, timestamp? } }.
 * Todos operam sobre o corpo BRUTO (Buffer) exatamente como chegou; nenhum lê o JSON. A tolerância de horário e o replay são da M9-D213.
 */
const ok = (extra = {}) => ({ ok: true, reason: null, ...extra });
const fail = (reason) => ({ ok: false, reason });

const prepare = (rawBody, secret) => {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return 'corpo ausente';
  if (typeof secret !== 'string' || secret.length === 0) return 'segredo ausente';
  return null;
};

/** HMAC-SHA256 do corpo, em hexadecimal, no cabeçalho `header` (com ou sem o prefixo `sha256=`). */
function hmacSha256Hex({ header = 'x-signature' } = {}) {
  return {
    name: 'hmacSha256Hex',
    verify({ rawBody, headers, secret }) {
      const problema = prepare(rawBody, secret);
      if (problema) return fail(problema);
      const recebido = headerText(headers, header);
      if (!recebido) return fail('cabeçalho de assinatura ausente');
      const obtido = hexToBuffer(recebido.startsWith('sha256=') ? recebido.slice(7) : recebido);
      if (!obtido) return fail('assinatura em formato inválido');
      return safeEqual(digest(secret, rawBody), obtido) ? ok() : fail('assinatura diferente');
    },
  };
}

/** HMAC-SHA256 do corpo, em base64, no cabeçalho `header`. */
function hmacSha256Base64({ header = 'x-signature' } = {}) {
  return {
    name: 'hmacSha256Base64',
    verify({ rawBody, headers, secret }) {
      const problema = prepare(rawBody, secret);
      if (problema) return fail(problema);
      const recebido = headerText(headers, header);
      if (!recebido) return fail('cabeçalho de assinatura ausente');
      const obtido = Buffer.from(recebido.startsWith('sha256=') ? recebido.slice(7) : recebido, 'base64');
      return safeEqual(digest(secret, rawBody), obtido) ? ok() : fail('assinatura diferente');
    },
  };
}

/** Cabeçalho `t=<segundos>,v1=<hex>[,v1=<hex>]`: HMAC-SHA256 de "<t>." + corpo. Devolve o horário assinado para a conferência de replay (M9-D213). */
function hmacWithTimestamp({ header = 'x-signature' } = {}) {
  return {
    name: 'hmacWithTimestamp',
    verify({ rawBody, headers, secret }) {
      const problema = prepare(rawBody, secret);
      if (problema) return fail(problema);
      const recebido = headerText(headers, header);
      if (!recebido) return fail('cabeçalho de assinatura ausente');
      let t = null;
      const assinaturas = [];
      recebido.split(',').forEach((par) => {
        const i = par.indexOf('=');
        if (i < 1) return;
        const k = par.slice(0, i).trim();
        const v = par.slice(i + 1).trim();
        if (k === 't') t = v;
        if (k === 'v1') assinaturas.push(v);
      });
      if (!t || !/^\d{1,12}$/.test(t) || assinaturas.length === 0) return fail('assinatura em formato inválido');
      const esperado = digest(secret, `${t}.`, rawBody);
      // Confere todas as v1 (rotação do fornecedor) sem parar na primeira, para o tempo não depender de qual casou.
      const casou = assinaturas.map((v1) => safeEqual(esperado, hexToBuffer(v1) || Buffer.alloc(0))).reduce((a, b) => a || b, false);
      return casou ? ok({ timestamp: Number(t) }) : fail('assinatura diferente');
    },
  };
}

module.exports = { hmacSha256Hex, hmacSha256Base64, hmacWithTimestamp };
