'use strict';

const crypto = require('crypto');
const AppError = require('./AppError');

/**
 * Criptografia simétrica (AES-256-GCM) do CONTEÚDO de arquivo em repouso (disco).
 *
 * ACHADO REAL FECHADO (auditoria pós-DoD, Marco 8, 14/10/2026): documentos financeiros/identidade
 * (comprovante de renda/extrato, RG/CPF) ficavam em disco sem nenhuma criptografia — gap
 * pré-existente de TODO o projeto (storage genérico usado por Jurídico/Obras/Estoque/
 * Correspondente), não específico de um módulo. Mesmo padrão de implementação de
 * `src/utils/mfaCrypto.js` (AES-256-GCM, chave dedicada, obrigatória, sem fallback — fail
 * closed), mas formato de serialização diferente: aqui o resultado precisa ser um Buffer binário
 * pronto pra gravar em disco (não uma string base64 pra coluna de banco), então o formato é
 * [MARKER(7) | IV(12) | AUTH_TAG(16) | CIPHERTEXT] concatenados como bytes crus, sem
 * delimitador — tamanhos fixos dispensam separador.
 *
 * COMPATIBILIDADE COM ARQUIVO LEGADO: todo arquivo gravado em disco ANTES desta mudança não tem
 * o MARKER no início. `decryptFileBuffer` detecta isso (os primeiros 7 bytes não batem com o
 * marker) e devolve o buffer original sem alteração — nunca tenta descriptografar algo que não
 * foi criptografado por esta função. Isso cobre tanto arquivos legados em disco quanto o
 * fallback de BLOB no Postgres (`File.content`, ver `files.service.js#getFileContent`), que
 * nunca passa por este módulo.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MARKER = Buffer.from('NAYENC1'); // 7 bytes — identifica conteúdo criptografado por esta função.

function getKey() {
  const raw = process.env.FILES_ENCRYPTION_KEY;
  if (!raw) {
    throw AppError.internal(
      'Variável de ambiente obrigatória ausente: FILES_ENCRYPTION_KEY.',
      'FILES_CRYPTO_CONFIG_MISSING'
    );
  }
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== 32) {
    throw AppError.internal(
      'FILES_ENCRYPTION_KEY inválida — deve resultar em 32 bytes (hex de 64 chars ou base64 equivalente).',
      'FILES_CRYPTO_CONFIG_INVALID'
    );
  }
  return key;
}

/**
 * encryptFileBuffer — recebe o Buffer de conteúdo original (plaintext) e devolve o Buffer pronto
 * pra gravar em disco: MARKER + IV + AUTH_TAG + CIPHERTEXT.
 */
function encryptFileBuffer(plainBuffer) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([MARKER, iv, authTag, encrypted]);
}

/**
 * decryptFileBuffer — recebe o Buffer lido do disco. Se começar com o MARKER, descriptografa e
 * devolve o plaintext original. Se NÃO começar com o MARKER (arquivo legado, gravado antes desta
 * mudança), devolve o buffer EXATAMENTE como veio — nunca lança erro por isso, é o caminho
 * esperado de compatibilidade.
 */
function decryptFileBuffer(diskBuffer) {
  if (!Buffer.isBuffer(diskBuffer) || diskBuffer.length < MARKER.length) {
    return diskBuffer;
  }
  const maybeMarker = diskBuffer.subarray(0, MARKER.length);
  if (!maybeMarker.equals(MARKER)) {
    // Arquivo legado (gravado antes da criptografia existir) — devolve sem alteração.
    return diskBuffer;
  }

  const key = getKey();
  const offset = MARKER.length;
  const iv = diskBuffer.subarray(offset, offset + IV_LENGTH);
  const authTag = diskBuffer.subarray(offset + IV_LENGTH, offset + IV_LENGTH + AUTH_TAG_LENGTH);
  const cipherText = diskBuffer.subarray(offset + IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(cipherText), decipher.final()]);
}

module.exports = { encryptFileBuffer, decryptFileBuffer };
