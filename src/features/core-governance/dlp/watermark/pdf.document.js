'use strict';

const { readValue, skipWs, readToken, isRef, isDict, PdfSyntaxError } = require('./pdf.lexer');
const { decodeStream, unsupported } = require('./pdf.stream');

const MAX_XREF_SECTIONS = 64;

/** Quebra os 2 primeiros números de uma linha de cabeçalho de objeto (`12 0 obj`). */
function readObjectHeader(buf, offset) {
  const text = buf.latin1Slice(offset, Math.min(buf.length, offset + 40));
  const match = /^[\0\t\n\f\r ]*(\d+)[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+obj/.exec(text);
  if (!match) throw new PdfSyntaxError('objeto não encontrado no deslocamento indicado');
  return { num: Number(match[1]), gen: Number(match[2]), pos: offset + match[0].length };
}

/**
 * Documento PDF em memória (M9-D920 §3.4): lê a cadeia de referências cruzadas (tabela clássica, fluxo XRef e objetos em fluxo) e entrega objetos e páginas. Só leitura; quem marca
 * acrescenta uma atualização no fim (pdf.stamp.js). PDF cifrado ou com filtro fora de FlateDecode é "não suportado" (o chamador recusa o download).
 */
function loadDocument(buf) {
  const entries = new Map();
  const cache = new Map();
  const objStreams = new Map();
  const info = { trailer: null, lastXrefOffset: null, lastXrefKind: null };

  function readClassicSection(startPos) {
    let pos = startPos;
    for (;;) {
      pos = skipWs(buf, pos);
      if (buf.latin1Slice(pos, pos + 7) === 'trailer') break;
      const first = readToken(buf, pos); const count = readToken(buf, skipWs(buf, first.pos));
      pos = skipWs(buf, count.pos);
      for (let i = 0; i < Number(count.text); i += 1) {
        const off = readToken(buf, skipWs(buf, pos)); const gen = readToken(buf, skipWs(buf, off.pos)); const flag = readToken(buf, skipWs(buf, gen.pos));
        const num = Number(first.text) + i;
        if (!entries.has(num)) entries.set(num, flag.text === 'n' ? { type: 1, offset: Number(off.text), gen: Number(gen.text) } : { type: 0 });
        pos = flag.pos;
      }
    }
    return readValue(buf, pos + 7).value.dict;
  }

  function readStreamSection(offset) {
    const obj = readIndirect(offset);
    const dict = obj.value.dict;
    const data = obj.stream();
    const [w1, w2, w3] = dict.W;
    const size = dict.Size;
    const index = dict.Index || [0, size];
    let at = 0;
    const field = (width) => { let v = 0; for (let i = 0; i < width; i += 1) { v = v * 256 + data[at]; at += 1; } return v; };
    for (let g = 0; g < index.length; g += 2) {
      for (let i = 0; i < index[g + 1]; i += 1) {
        const type = w1 ? field(w1) : 1; const a = field(w2); const b = field(w3);
        const num = index[g] + i;
        if (!entries.has(num)) entries.set(num, type === 1 ? { type: 1, offset: a, gen: b } : (type === 2 ? { type: 2, stream: a, index: b } : { type: 0 }));
      }
    }
    return dict;
  }

  function walk(startOffset) {
    const seen = new Set();
    let offset = startOffset;
    let first = true;
    while (offset !== undefined && offset !== null) {
      if (seen.has(offset) || seen.size > MAX_XREF_SECTIONS) throw new PdfSyntaxError('cadeia de referências cruzadas em laço');
      seen.add(offset);
      const pos = skipWs(buf, offset);
      const classic = buf.latin1Slice(pos, pos + 4) === 'xref';
      const trailer = classic ? readClassicSection(pos + 4) : readStreamSection(pos);
      if (first) { info.trailer = trailer; info.lastXrefOffset = offset; info.lastXrefKind = classic ? 'table' : 'stream'; first = false; }
      if (classic && Number.isInteger(trailer.XRefStm)) readStreamSection(trailer.XRefStm);
      offset = trailer.Prev;
    }
  }

  function readIndirect(offset) {
    const header = readObjectHeader(buf, offset);
    const parsed = readValue(buf, header.pos);
    let streamAt = skipWs(buf, parsed.pos);
    const isStream = isDict(parsed.value) && buf.latin1Slice(streamAt, streamAt + 6) === 'stream';
    return {
      num: header.num, gen: header.gen, value: parsed.value, isStream,
      stream() {
        if (!isStream) return null;
        streamAt += 6;
        if (buf[streamAt] === 13) streamAt += 1;
        if (buf[streamAt] === 10) streamAt += 1;
        let length = parsed.value.dict.Length;
        if (isRef(length)) length = resolve(length);
        let end = streamAt + (Number.isInteger(length) ? length : 0);
        if (!Number.isInteger(length) || buf.latin1Slice(skipWs(buf, end), skipWs(buf, end) + 9) !== 'endstream') end = buf.indexOf('endstream', streamAt, 'latin1');
        if (end < 0) throw new PdfSyntaxError('fluxo sem fim');
        return decodeStream(parsed.value.dict, buf.subarray(streamAt, end), resolve(parsed.value.dict.DecodeParms));
      },
    };
  }

  function objectStream(num) {
    if (!objStreams.has(num)) {
      const holder = getObject(num);
      if (!holder || !holder.isStream) throw new PdfSyntaxError('fluxo de objetos ausente');
      const data = holder.stream();
      const count = holder.value.dict.N; const firstAt = holder.value.dict.First;
      const head = data.latin1Slice(0, firstAt).trim().split(/\s+/).map(Number);
      objStreams.set(num, { data, firstAt, pairs: Array.from({ length: count }, (_x, i) => [head[2 * i], head[2 * i + 1]]) });
    }
    return objStreams.get(num);
  }

  function getObject(num) {
    if (cache.has(num)) return cache.get(num);
    const entry = entries.get(num);
    let out = null;
    if (entry && entry.type === 1) out = readIndirect(entry.offset);
    else if (entry && entry.type === 2) {
      const holder = objectStream(entry.stream);
      const pair = holder.pairs[entry.index];
      out = { num, gen: 0, value: readValue(holder.data, holder.firstAt + pair[1]).value, isStream: false, stream: () => null };
    }
    cache.set(num, out);
    return out;
  }

  /** Segue referências até o valor (dicionário, lista, número...); referência para nada = null. */
  function resolve(value) {
    let current = value;
    for (let i = 0; i < 16 && isRef(current); i += 1) { const obj = getObject(current.ref); current = obj ? obj.value : null; }
    return current;
  }

  const tail = buf.latin1Slice(Math.max(0, buf.length - 2048), buf.length);
  const mark = tail.lastIndexOf('startxref');
  const startMatch = mark >= 0 ? /^startxref[\0\t\n\f\r ]+(\d+)/.exec(tail.slice(mark)) : null;
  if (!buf.latin1Slice(0, Math.min(buf.length, 1024)).includes('%PDF-') || !startMatch) throw new PdfSyntaxError('não é um PDF legível');
  walk(Number(startMatch[1]));
  if (!info.trailer || !isRef(info.trailer.Root)) throw new PdfSyntaxError('PDF sem raiz');
  if (info.trailer.Encrypt) throw unsupported('PDF cifrado');
  const maxObject = Math.max(info.trailer.Size || 0, ...entries.keys()) + 1;
  return { getObject, resolve, entries, trailer: info.trailer, info, startXref: Number(startMatch[1]), nextObjectNumber: maxObject, previousSize: info.trailer.Size || maxObject };
}

module.exports = { loadDocument };
