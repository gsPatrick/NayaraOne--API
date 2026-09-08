'use strict';

const crypto = require('crypto');
const AppError = require('./AppError');

/**
 * Criptografia simétrica (AES-256-GCM) do segredo TOTP em repouso.
 *
 * DECISÃO DE ENGENHARIA — não especificado no Caderno: o Caderno pede apenas que o segredo
 * seja "armazenado de forma segura", sem detalhar o mecanismo. Não existia, até aqui, nenhum
 * helper de criptografia REVERSÍVEL no projeto — apenas HMAC de via única (PII_HASH_SECRET,
 * ver src/features/people/personDocumentFormat.service.js), que serve para busca exata mas
 * não permite recuperar o valor original, e o segredo TOTP precisa ser recuperado em texto
 * claro a cada `verify` para gerar o código esperado e comparar. Optou-se por AES-256-GCM
 * (autenticado, padrão do Node `crypto`, sem dependência nova) com uma chave dedicada
 * (`MFA_ENCRYPTION_KEY`), seguindo o mesmo padrão de "variável obrigatória, sem fallback,
 * falha fechada" já usado por JWT_ACCESS_SECRET/PII_HASH_SECRET — nunca reaproveitar segredos
 * entre finalidades diferentes. O segredo em texto claro NUNCA é logado (nem em erro).
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recomendado para GCM

function getKey() {
  const raw = process.env.MFA_ENCRYPTION_KEY;
  if (!raw) {
    throw AppError.internal(
      'Variável de ambiente obrigatória ausente: MFA_ENCRYPTION_KEY.',
      'MFA_CRYPTO_CONFIG_MISSING'
    );
  }
  // Aceita chave em hex (64 chars = 32 bytes) ou base64; nunca texto arbitrário truncado —
  // erra explicitamente se o tamanho resultante não for 32 bytes (AES-256).
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== 32) {
    throw AppError.internal(
      'MFA_ENCRYPTION_KEY inválida — deve resultar em 32 bytes (hex de 64 chars ou base64 equivalente).',
      'MFA_CRYPTO_CONFIG_INVALID'
    );
  }
  return key;
}

function encryptSecret(plainText) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Formato serializado: iv:authTag:cipherText, tudo em base64 — auto-contido em uma coluna.
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptSecret(serialized) {
  const key = getKey();
  const parts = String(serialized).split(':');
  if (parts.length !== 3) {
    throw AppError.internal('Segredo MFA armazenado em formato inválido.', 'MFA_CRYPTO_INVALID_PAYLOAD');
  }
  const [ivB64, authTagB64, cipherTextB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const cipherText = Buffer.from(cipherTextB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
