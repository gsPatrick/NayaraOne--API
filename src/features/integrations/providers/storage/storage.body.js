'use strict';

const crypto = require('node:crypto');
const { sha256Mismatch, tooLarge, bodyMissing } = require('./storage.errors');

/** Conteúdo do pedido (Buffer, texto ou stream legível) como Buffer, com teto de bytes. */
async function toBuffer(body, maxBytes = Infinity) {
  if (body === undefined || body === null) throw bodyMissing();
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (b.length > maxBytes) throw tooLarge(maxBytes);
    return b;
  }
  const partes = [];
  let total = 0;
  for await (const parte of body) {
    const b = Buffer.isBuffer(parte) ? parte : Buffer.from(parte);
    total += b.length;
    if (total > maxBytes) throw tooLarge(maxBytes);
    partes.push(b);
  }
  return Buffer.concat(partes);
}

const sha256Of = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/** Confere o hash informado (hex, qualquer caixa) com o do conteúdo; 422 INTEGRATION_STORAGE_SHA256_MISMATCH se diferir. Sem hash informado: só calcula. */
function checkSha256(buffer, informed) {
  const calculado = sha256Of(buffer);
  if (informed && String(informed).toLowerCase() !== calculado) throw sha256Mismatch();
  return calculado;
}

module.exports = { toBuffer, sha256Of, checkSha256 };
