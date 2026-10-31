'use strict';

/**
 * Criptografia dos backups agendados: AES-256-GCM em streaming.
 * Formato: "NAYBK1" (6 bytes) + IV (12 bytes) + texto cifrado + tag GCM (16 bytes).
 * A tag é conferida no fim da decifragem; arquivo adulterado ou chave errada = erro, e o
 * arquivo de saída parcial é apagado.
 */

const fs = require('fs');
const crypto = require('crypto');
const { once } = require('events');
const { pipeline } = require('stream/promises');

const MAGIC = Buffer.from('NAYBK1');

function loadKey(hex) {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('BACKUP_ENCRYPTION_KEY ausente ou inválida (precisa de 64 caracteres hex = 32 bytes). Gere com: openssl rand -hex 32');
  }
  return Buffer.from(hex, 'hex');
}

async function encryptFile(src, dest, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = fs.createWriteStream(dest, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, iv]));
  for await (const chunk of fs.createReadStream(src)) {
    if (!out.write(cipher.update(chunk))) await once(out, 'drain');
  }
  out.write(cipher.final());
  out.end(cipher.getAuthTag());
  await once(out, 'finish');
}

async function decryptFile(src, dest, key) {
  const size = fs.statSync(src).size;
  const fd = fs.openSync(src, 'r');
  const head = Buffer.alloc(18);
  const tag = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 18, 0);
  fs.readSync(fd, tag, 0, 16, size - 16);
  fs.closeSync(fd);
  if (!head.subarray(0, 6).equals(MAGIC)) throw new Error('arquivo não é um backup cifrado do Nayara One (cabeçalho inválido)');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, head.subarray(6, 18));
  decipher.setAuthTag(tag);
  try {
    await pipeline(fs.createReadStream(src, { start: 18, end: size - 17 }), decipher, fs.createWriteStream(dest, { mode: 0o600 }));
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw new Error(`decifragem falhou (chave errada ou arquivo adulterado): ${err.message}`);
  }
}

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

module.exports = { loadKey, encryptFile, decryptFile, sha256File };
