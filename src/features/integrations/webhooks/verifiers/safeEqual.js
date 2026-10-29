'use strict';

const crypto = require('crypto');

/**
 * Comparação de assinatura em tempo constante (M9-D211 5): crypto.timingSafeEqual sobre buffers do mesmo tamanho. Tamanho diferente é
 * "diferente" sem comparar byte a byte (o tamanho da assinatura esperada não é segredo). Nunca `===` em assinatura.
 */
function safeEqual(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

const digest = (secret, ...partes) => {
  const h = crypto.createHmac('sha256', secret);
  partes.forEach((p) => h.update(p));
  return h.digest();
};

const HEX_RE = /^[0-9a-f]+$/i;
const hexToBuffer = (texto) => (typeof texto === 'string' && texto.length % 2 === 0 && HEX_RE.test(texto) ? Buffer.from(texto, 'hex') : null);

/** Valor do cabeçalho como texto (o Node junta repetidos com vírgula; lista vira o primeiro). */
const headerText = (headers, nome) => {
  const v = headers ? headers[String(nome).toLowerCase()] : undefined;
  const t = Array.isArray(v) ? v[0] : v;
  return typeof t === 'string' ? t.trim() : '';
};

module.exports = { safeEqual, digest, hexToBuffer, headerText };
