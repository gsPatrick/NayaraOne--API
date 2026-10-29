'use strict';

const crypto = require('crypto');

const HEADER = 'x-webhook-signature';

/**
 * Verificação HMAC-SHA256 do corpo bruto (cabeçalho x-webhook-signature, com ou sem "sha256="), com comparação em tempo
 * constante. É o mesmo esquema dos webhooks de financiamento, seguro e Clicksign; os sandboxes que não tinham verificação
 * própria usam esta (M9-D209).
 */
function hmacVerify(rawBody, headers, secret) {
  if (!secret || !rawBody || rawBody.length === 0) return false;
  const recebido = headers ? headers[HEADER] : null;
  if (!recebido || typeof recebido !== 'string') return false;
  const hex = recebido.startsWith('sha256=') ? recebido.slice('sha256='.length) : recebido;
  const esperado = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
  const obtido = Buffer.from(hex, 'hex');
  return esperado.length === obtido.length && crypto.timingSafeEqual(esperado, obtido);
}

module.exports = { hmacVerify };
