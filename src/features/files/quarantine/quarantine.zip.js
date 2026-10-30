'use strict';

const zlib = require('node:zlib');

/**
 * Inspeção de arquivo compactado sem extrair para o disco (M9-D247 3.1 item 2g): lê o diretório central do ZIP (nomes, tamanho compactado e descompactado) e confere a razão
 * de descompressão (total e por arquivo) e a profundidade (zip dentro de zip). Os tamanhos declarados no diretório não são confiados: o arquivo aninhado só é aberto até `limitBytes`.
 */
const EOCD = 0x06054b50;
const CEN = 0x02014b50;

function entriesOf(buffer) {
  const inicio = Math.max(0, buffer.length - 65557);
  let fim = -1;
  for (let i = buffer.length - 22; i >= inicio; i -= 1) if (buffer.readUInt32LE(i) === EOCD) { fim = i; break; }
  if (fim < 0) return null;
  const total = buffer.readUInt16LE(fim + 10);
  let pos = buffer.readUInt32LE(fim + 16);
  const lista = [];
  for (let n = 0; n < total && pos + 46 <= buffer.length && buffer.readUInt32LE(pos) === CEN; n += 1) {
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    lista.push({
      name: buffer.toString('utf8', pos + 46, pos + 46 + nameLen), method: buffer.readUInt16LE(pos + 10), compressed: buffer.readUInt32LE(pos + 20), size: buffer.readUInt32LE(pos + 24), offset: buffer.readUInt32LE(pos + 42),
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return lista;
}

/** Conteúdo (descompactado) de uma entrada, ou null se passar de `limitBytes` ou não abrir. */
function readEntry(buffer, e, limitBytes) {
  if (e.size > limitBytes || e.offset + 30 > buffer.length) return null;
  const nameLen = buffer.readUInt16LE(e.offset + 26);
  const extraLen = buffer.readUInt16LE(e.offset + 28);
  const dados = buffer.subarray(e.offset + 30 + nameLen + extraLen, e.offset + 30 + nameLen + extraLen + e.compressed);
  try { return e.method === 0 ? dados : zlib.inflateRawSync(dados, { maxOutputLength: limitBytes }); } catch { return null; }
}

const isZip = (b) => b.length > 22 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/**
 * Veredito do arquivo compactado: { ok, reason?, entries } (`reason`: RATIO, DEPTH, CORRUPT). Razão = descompactado / compactado, no arquivo todo (contra o tamanho do ZIP) e em cada entrada;
 * profundidade conta o ZIP de fora como nível 1.
 */
function inspectZip(buffer, { maxDepth, maxRatio, limitBytes }, depth = 1) {
  const entradas = entriesOf(buffer);
  if (!entradas) return { ok: false, reason: 'CORRUPT', entries: [] };
  if (depth > maxDepth) return { ok: false, reason: 'DEPTH', entries: entradas };
  const total = entradas.reduce((s, e) => s + e.size, 0);
  if (buffer.length > 0 && total / buffer.length > maxRatio) return { ok: false, reason: 'RATIO', entries: entradas };
  if (entradas.some((e) => e.compressed > 0 && e.size / e.compressed > maxRatio)) return { ok: false, reason: 'RATIO', entries: entradas };
  for (const e of entradas) {
    if (e.size === 0) continue;
    const dentro = readEntry(buffer, e, limitBytes);
    if (dentro && isZip(dentro)) {
      const r = inspectZip(dentro, { maxDepth, maxRatio, limitBytes }, depth + 1);
      if (!r.ok) return { ...r, entries: entradas };
    }
  }
  return { ok: true, entries: entradas };
}

module.exports = { inspectZip, entriesOf, isZip };
