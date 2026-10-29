'use strict';

const zlib = require('node:zlib');

/**
 * Leitor mínimo de ZIP (só o que o DOCX precisa), em memória: lê o diretório central e expande uma entrada por vez com teto de saída
 * (`maxBytes`), para um arquivo comprimido malicioso não esgotar a memória. Sem escrita em disco. Falha = Error com `code` ZIP_INVALID
 * ou ZIP_TOO_LARGE.
 */
const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const fail = (code) => Object.assign(new Error(code), { code });

function findEndOfDirectory(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i -= 1) if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  throw fail('ZIP_INVALID');
}

/** Entradas do arquivo: [{ name, method, compressedSize, size, offset }]. */
function listEntries(buf) {
  if (buf.length < 22) throw fail('ZIP_INVALID');
  const eocd = findEndOfDirectory(buf);
  const total = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < total; i += 1) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== SIG_CENTRAL) throw fail('ZIP_INVALID');
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    entries.push({
      name: buf.toString('utf8', pos + 46, pos + 46 + nameLen), method: buf.readUInt16LE(pos + 10),
      compressedSize: buf.readUInt32LE(pos + 20), size: buf.readUInt32LE(pos + 24), offset: buf.readUInt32LE(pos + 42),
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Conteúdo expandido de uma entrada; acima de `maxBytes` é ZIP_TOO_LARGE. */
function readEntry(buf, entry, maxBytes) {
  if (entry.size > maxBytes) throw fail('ZIP_TOO_LARGE');
  const p = entry.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== SIG_LOCAL) throw fail('ZIP_INVALID');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method !== 8) throw fail('ZIP_INVALID');
  try {
    return zlib.inflateRawSync(data, { maxOutputLength: maxBytes });
  } catch (err) {
    throw fail(err && err.code === 'ERR_BUFFER_TOO_LARGE' ? 'ZIP_TOO_LARGE' : 'ZIP_INVALID');
  }
}

module.exports = { listEntries, readEntry };
