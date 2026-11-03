'use strict';

const crypto = require('crypto');
const { encryptSecret, decryptSecret } = require('./mfaCrypto');

/**
 * Cifra a leitura automática de documentos do caso (dado de identidade/renda). Chave própria
 * (CASE_DOCUMENT_ENCRYPTION_KEY, hex de 64 ou base64 de 32 bytes), separada da chave do MFA. Sem a
 * variável, mantém a chave do MFA (prefixo "enc:") para não quebrar quem ainda não a configurou;
 * com ela, o texto novo sai com o prefixo "enc2:". Os dois formatos continuam legíveis.
 */
function ownKey() {
  const raw = process.env.CASE_DOCUMENT_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
}

function encryptNote(plain) {
  const key = ownKey();
  if (!key) return `enc:${encryptSecret(String(plain))}`;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `enc2:${[iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join(':')}`;
}

function decryptNote(stored) {
  const text = String(stored);
  if (text.startsWith('enc2:')) {
    const key = ownKey();
    if (!key) throw new Error('CASE_DOCUMENT_ENCRYPTION_KEY ausente');
    const [iv, tag, body] = text.slice(5).split(':').map((p) => Buffer.from(p, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }
  return decryptSecret(text.slice(4));
}

module.exports = { encryptNote, decryptNote };
