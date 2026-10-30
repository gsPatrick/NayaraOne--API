'use strict';

// M9-D021 — texto escondido em base64: o InjectionDetector decodifica os trechos "óbvios" e confere o resultado como se fosse a entrada
// (um nível dentro de outro: o decodificado também é procurado). Só vale decodificação que vira texto legível.

const TOKEN = /[A-Za-z0-9+/_-]{20,}={0,2}/g;
const MAX_TOKENS = 20;
const MAX_DEPTH = 2;
const MIN_PRINTABLE_RATIO = 0.9;
const MIN_DECODED_LENGTH = 8;

const printableRatio = (texto) => {
  const chars = Array.from(texto);
  return chars.length ? chars.filter((c) => /[\p{L}\p{N}\p{P}\p{Zs}\n\r\t]/u.test(c)).length / chars.length : 0;
};

function decodeToken(token) {
  try {
    const texto = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return texto.length >= MIN_DECODED_LENGTH && !texto.includes('�') && printableRatio(texto) >= MIN_PRINTABLE_RATIO ? texto : null;
  } catch (err) {
    return null;
  }
}

/** Textos legíveis encontrados dentro de trechos base64 da entrada (inclusive base64 dentro de base64). */
function decodedSegments(texto, depth = 0) {
  if (depth >= MAX_DEPTH) return [];
  const achados = [];
  for (const token of (String(texto || '').match(TOKEN) || []).slice(0, MAX_TOKENS)) {
    const decodificado = decodeToken(token);
    if (decodificado) achados.push(decodificado, ...decodedSegments(decodificado, depth + 1));
  }
  return achados;
}

module.exports = { decodedSegments };
