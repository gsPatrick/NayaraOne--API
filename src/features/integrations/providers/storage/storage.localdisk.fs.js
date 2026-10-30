'use strict';

const fs = require('node:fs');
const path = require('node:path');
const diskStorage = require('../../../../utils/diskStorage');
const { encryptFileBuffer, decryptFileBuffer, isEncryptedBuffer } = require('../../../../utils/fileCrypto');
const { RESERVED_SUFFIX } = require('./storage.key');
const { notFound, integrity } = require('./storage.errors');
const { sha256Of } = require('./storage.body');

/**
 * Disco local do servidor (driver `storage-local-disk`, M9-D242): o mesmo layout de `uploads/` que o sistema já usa. O objeto é gravado cifrado (AES-256-GCM de
 * `utils/fileCrypto.js`, gerida pelo driver) e acompanhado de um arquivo `<objeto>.meta` com o hash do conteúdo original, o tipo e o tamanho. O caminho relativo
 * da chave já chegou validado por `assertCompanyKey` (sem `..`, só segmentos seguros); aqui o caminho ainda é conferido contra a raiz.
 */
function absolute(relative) {
  // A raiz acompanha UPLOADS_DIR no momento da chamada (a suíte de contrato aponta para uma pasta temporária); sem ela vale a raiz do sistema.
  const raiz = path.resolve(process.env.UPLOADS_DIR || diskStorage.UPLOADS_ROOT);
  const alvo = path.resolve(raiz, relative);
  if (!alvo.startsWith(raiz + path.sep)) throw Object.assign(new Error('Caminho fora da raiz de uploads.'), { code: 'INTEGRATION_STORAGE_KEY_FORBIDDEN', status: 403 });
  return alvo;
}

const metaPath = (file) => `${file}${RESERVED_SUFFIX}`;

function write(relative, plain, meta) {
  const file = absolute(relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encryptFileBuffer(plain));
  const tipo = String(meta.contentType || 'application/octet-stream').replace(/[\r\n]/g, ' ').slice(0, 120);
  fs.writeFileSync(metaPath(file), `sha256=${sha256Of(plain)}\nsizeBytes=${plain.length}\ncontentType=${tipo}\ncreatedAt=${new Date().toISOString()}\n`);
  return { sha256: sha256Of(plain), sizeBytes: plain.length };
}

/** Metadados ao lado do objeto: uma linha `chave=valor` por campo (hash do conteúdo original, tamanho e tipo). Ausente ou ilegível: null (objeto antigo). */
function readMeta(file) {
  try {
    const campos = Object.fromEntries(fs.readFileSync(metaPath(file), 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    return { sha256: campos.sha256 || null, sizeBytes: Number(campos.sizeBytes) || 0, contentType: campos.contentType || null };
  } catch { return null; }
}

/** Lê e decifra. Arquivo legado (sem marcador de cifra) volta como está; marcador presente e cifra adulterada: 409 de integridade. */
function read(relative, { expectEncrypted = false } = {}) {
  const file = absolute(relative);
  if (!fs.existsSync(file)) throw notFound();
  const raw = fs.readFileSync(file);
  const cifrado = isEncryptedBuffer(raw);
  if (expectEncrypted && !cifrado) throw integrity('NO_CIPHER_MARKER');
  let plain;
  try { plain = decryptFileBuffer(raw); } catch (err) { throw integrity('CIPHER_AUTH_FAILED'); }
  const meta = readMeta(file);
  if (meta && meta.sha256 && meta.sha256 !== sha256Of(plain)) throw integrity('SHA256_MISMATCH');
  return { plain, encryptedAtRest: cifrado, meta };
}

function head(relative) {
  const file = absolute(relative);
  if (!fs.existsSync(file)) return null;
  const meta = readMeta(file);
  return { sizeBytes: meta ? meta.sizeBytes : fs.statSync(file).size, contentType: meta ? meta.contentType : null, sha256: meta ? meta.sha256 : null };
}

function remove(relative) {
  const file = absolute(relative);
  [file, metaPath(file)].forEach((f) => { try { fs.unlinkSync(f); } catch { /* já ausente */ } });
}

module.exports = { write, read, head, remove };
