'use strict';

const crypto = require('node:crypto');
const { storeConfig, storeUnavailable } = require('./secrets.errors');

/**
 * Cifra do cofre em arquivo (M9-D202 3.1a): AES-256-GCM no mesmo formato de utils/fileCrypto.js
 * [MARCADOR(7) | IV(12) | TAG(16) | CIFRADO], com chave mestra PRÓPRIA do cofre (nunca a dos arquivos) e
 * a referência + versão como dado autenticado, para um arquivo não valer em outro lugar.
 */
const MARKER = Buffer.from('NAYSEC1');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function parseMasterKey(raw) {
  if (!raw) throw storeConfig('chave mestra ausente (SECRET_STORE_MASTER_KEY).');
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(String(raw), 'base64');
  if (key.length !== 32) throw storeConfig('a chave mestra deve ter 32 bytes (hex de 64 caracteres ou base64 equivalente).');
  return key;
}

function encryptValue(plain, key, aad) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const cifrado = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
  return Buffer.concat([MARKER, iv, cipher.getAuthTag(), cifrado]);
}

/** Qualquer falha (chave errada, arquivo adulterado, formato) vira "cofre indisponível", sem detalhe. */
function decryptValue(disco, key, aad) {
  try {
    if (!Buffer.isBuffer(disco) || !disco.subarray(0, MARKER.length).equals(MARKER)) throw new Error('formato');
    const iv = disco.subarray(MARKER.length, MARKER.length + IV_LENGTH);
    const tag = disco.subarray(MARKER.length + IV_LENGTH, MARKER.length + IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(disco.subarray(MARKER.length + IV_LENGTH + TAG_LENGTH)), decipher.final()]).toString('utf8');
  } catch (err) {
    throw storeUnavailable();
  }
}

module.exports = { parseMasterKey, encryptValue, decryptValue };
