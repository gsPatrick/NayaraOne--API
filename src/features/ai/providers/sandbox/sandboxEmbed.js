'use strict';

const crypto = require('node:crypto');
const { SANDBOX_DIMENSIONS } = require('./sandboxModels');

const NGRAM = 3;

/**
 * Vetor de 64 dimensões derivado do texto: hash de n-gramas de 3 caracteres (cada um soma +1 ou -1 numa dimensão), normalizado
 * pela norma. Textos iguais dão vetores iguais; textos parecidos compartilham n-gramas e ficam próximos. Sem rede, sem aleatório.
 */
function sandboxEmbedText(texto) {
  const t = String(texto ?? '').toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
  const grams = [];
  for (let i = 0; i + NGRAM <= t.length; i += 1) grams.push(t.slice(i, i + NGRAM));
  if (grams.length === 0) grams.push(t);
  const v = new Array(SANDBOX_DIMENSIONS).fill(0);
  for (const g of grams) {
    const h = crypto.createHash('sha256').update(g).digest();
    v[h[0] % SANDBOX_DIMENSIONS] += (h[1] & 1) ? 1 : -1;
  }
  const norma = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => Math.round((x / norma) * 1e6) / 1e6);
}

module.exports = { sandboxEmbedText };
