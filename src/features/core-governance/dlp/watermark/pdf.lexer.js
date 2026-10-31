'use strict';

/**
 * Leitor de objetos PDF (M9-D920 §3.4): transforma o texto de um objeto em estrutura de JavaScript, só o necessário para ler a árvore de páginas e reescrever um dicionário de página.
 * Representação: número = number; verdadeiro/falso/nulo = boolean/null; nome = { name }; referência = { ref, gen }; string = { str: Buffer }; lista = Array; dicionário = { dict: {} }.
 */
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const MAX_DEPTH = 64;

class PdfSyntaxError extends Error {}

function skipWs(buf, start) {
  let pos = start;
  while (pos < buf.length) {
    const c = buf[pos];
    if (WS.has(c)) pos += 1;
    else if (c === 37) { while (pos < buf.length && buf[pos] !== 10 && buf[pos] !== 13) pos += 1; } else break;
  }
  return pos;
}

function readToken(buf, start) {
  let pos = start;
  while (pos < buf.length && !WS.has(buf[pos]) && !DELIM.has(buf[pos])) pos += 1;
  return { text: buf.latin1Slice(start, pos), pos };
}

function readName(buf, start) {
  const { text, pos } = readToken(buf, start + 1);
  return { value: { name: text.replace(/#([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16))) }, pos };
}

function readLiteralString(buf, start) {
  const out = [];
  let depth = 1;
  let pos = start + 1;
  while (pos < buf.length && depth > 0) {
    const c = buf[pos];
    if (c === 92) {
      const next = buf[pos + 1];
      const simple = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 }[next];
      if (simple !== undefined) { out.push(simple); pos += 2; } else if (next >= 48 && next <= 55) {
        let end = pos + 1; let code = 0;
        while (end < pos + 4 && buf[end] >= 48 && buf[end] <= 55) { code = code * 8 + (buf[end] - 48); end += 1; }
        out.push(code & 255); pos = end;
      } else if (next === 13 || next === 10) { pos += next === 13 && buf[pos + 2] === 10 ? 3 : 2; } else { out.push(next); pos += 2; }
    } else {
      if (c === 40) depth += 1;
      if (c === 41) depth -= 1;
      if (depth > 0) out.push(c);
      pos += 1;
    }
  }
  return { value: { str: Buffer.from(out) }, pos };
}

function readHexString(buf, start) {
  const end = buf.indexOf(62, start);
  if (end < 0) throw new PdfSyntaxError('string hexadecimal sem fim');
  const hex = buf.latin1Slice(start + 1, end).replace(/[^0-9a-fA-F]/g, '');
  return { value: { str: Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex') }, pos: end + 1 };
}

function readNumberOrRef(buf, start) {
  const { text, pos } = readToken(buf, start);
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) throw new PdfSyntaxError(`token inesperado "${text.slice(0, 20)}"`);
  if (/^\d+$/.test(text)) {
    const ahead = /^[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+R(?![A-Za-z0-9])/.exec(buf.latin1Slice(pos, Math.min(buf.length, pos + 40)));
    if (ahead) return { value: { ref: Number(text), gen: Number(ahead[1]) }, pos: pos + ahead[0].length };
  }
  return { value: Number(text), pos };
}

function readValue(buf, start, depth = 0) {
  if (depth > MAX_DEPTH) throw new PdfSyntaxError('estrutura aninhada demais');
  const pos = skipWs(buf, start);
  const c = buf[pos];
  if (c === undefined) throw new PdfSyntaxError('fim inesperado');
  if (c === 60 && buf[pos + 1] === 60) return readDict(buf, pos + 2, depth);
  if (c === 60) return readHexString(buf, pos);
  if (c === 40) return readLiteralString(buf, pos);
  if (c === 47) return readName(buf, pos);
  if (c === 91) return readArray(buf, pos + 1, depth);
  const keyword = readToken(buf, pos);
  if (keyword.text === 'true') return { value: true, pos: keyword.pos };
  if (keyword.text === 'false') return { value: false, pos: keyword.pos };
  if (keyword.text === 'null') return { value: null, pos: keyword.pos };
  return readNumberOrRef(buf, pos);
}

function readArray(buf, start, depth) {
  const items = [];
  let pos = skipWs(buf, start);
  while (buf[pos] !== 93) {
    if (pos >= buf.length) throw new PdfSyntaxError('lista sem fim');
    const item = readValue(buf, pos, depth + 1);
    items.push(item.value);
    pos = skipWs(buf, item.pos);
  }
  return { value: items, pos: pos + 1 };
}

function readDict(buf, start, depth) {
  const dict = {};
  let pos = skipWs(buf, start);
  while (!(buf[pos] === 62 && buf[pos + 1] === 62)) {
    if (pos >= buf.length || buf[pos] !== 47) throw new PdfSyntaxError('dicionário malformado');
    const key = readName(buf, pos);
    const val = readValue(buf, key.pos, depth + 1);
    dict[key.value.name] = val.value;
    pos = skipWs(buf, val.pos);
  }
  return { value: { dict }, pos: pos + 2 };
}

const isName = (value, name) => Boolean(value) && typeof value === 'object' && value.name === name;
const isRef = (value) => Boolean(value) && typeof value === 'object' && Number.isInteger(value.ref);
const isDict = (value) => Boolean(value) && typeof value === 'object' && Boolean(value.dict);

module.exports = { readValue, skipWs, readToken, isName, isRef, isDict, PdfSyntaxError };
