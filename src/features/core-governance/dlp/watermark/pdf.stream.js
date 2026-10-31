'use strict';

const zlib = require('node:zlib');
const { isName, isDict } = require('./pdf.lexer');

const unsupported = (message) => Object.assign(new Error(message), { pdfUnsupported: true });

/** Desfaz o preditor PNG (10 a 15) dos fluxos de referência cruzada e de objetos. */
function unpredictPng(data, columns) {
  const row = columns;
  const rows = Math.floor(data.length / (row + 1));
  const out = Buffer.alloc(rows * row);
  for (let r = 0; r < rows; r += 1) {
    const kind = data[r * (row + 1)];
    for (let i = 0; i < row; i += 1) {
      const raw = data[r * (row + 1) + 1 + i];
      const left = i > 0 ? out[r * row + i - 1] : 0;
      const up = r > 0 ? out[(r - 1) * row + i] : 0;
      const upLeft = r > 0 && i > 0 ? out[(r - 1) * row + i - 1] : 0;
      let add = 0;
      if (kind === 1) add = left; else if (kind === 2) add = up; else if (kind === 3) add = (left + up) >> 1; else if (kind === 4) {
        const p = left + up - upLeft; const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - upLeft);
        add = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft);
      } else if (kind !== 0) throw unsupported('preditor de fluxo desconhecido');
      out[r * row + i] = (raw + add) & 255;
    }
  }
  return out;
}

function filterNames(dict) {
  const filter = dict.Filter;
  if (!filter) return [];
  return (Array.isArray(filter) ? filter : [filter]).map((item) => (isName(item, item && item.name) ? item.name : null));
}

/** Conteúdo decodificado de um fluxo (só FlateDecode, com ou sem preditor PNG; outro filtro é "não suportado"). `parms` já resolvido para JavaScript simples. */
function decodeStream(dict, raw, parms) {
  const filters = filterNames(dict);
  if (filters.some((name) => name !== 'FlateDecode' && name !== 'Fl')) throw unsupported('filtro de fluxo não suportado');
  if (!filters.length) return raw;
  let data = zlib.inflateSync(raw);
  const options = isDict(parms) ? parms.dict : {};
  const predictor = options.Predictor || 1;
  if (predictor >= 10) data = unpredictPng(data, options.Columns || 1);
  else if (predictor !== 1) throw unsupported('preditor de fluxo não suportado');
  return data;
}

module.exports = { decodeStream, unsupported };
