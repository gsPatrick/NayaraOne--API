'use strict';

const crypto = require('crypto');

/** JSON canônico: chaves em ordem alfabética em qualquer profundidade, sem espaço; undefined sai como em JSON.stringify. */
function canonicalize(valor) {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map((v) => (v === undefined ? 'null' : canonicalize(v))).join(',')}]`;
  const partes = Object.keys(valor).filter((k) => valor[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(valor[k])}`);
  return `{${partes.join(',')}}`;
}

/** SHA-256 hexadecimal do JSON canônico: o mesmo conteúdo em qualquer ordem de chaves tem o mesmo hash. */
const hashPayload = (snapshot) => crypto.createHash('sha256').update(canonicalize(snapshot), 'utf8').digest('hex');

module.exports = { canonicalize, hashPayload };
