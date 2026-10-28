'use strict';

const E = require('./runs.errors');

/**
 * Custo do run em BRL com seis casas, sem ponto flutuante: preços por token entram como texto decimal (até 12 casas), as
 * contas são feitas em BigInt na escala 1e12 e o resultado arredonda meio para cima na sexta casa.
 * 1200 tokens a 0,000010 + 300 a 0,000030 = 0,021000.
 */
const ESCALA_PRECO = 12;
const ESCALA_CUSTO = 6;

function precoEmUnidades(valor, nome) {
  const texto = typeof valor === 'number' ? String(valor) : valor;
  const m = typeof texto === 'string' ? /^(\d+)(?:\.(\d{1,12}))?$/.exec(texto.trim()) : null;
  if (!m) throw E.invalid(`Preço por token inválido (${nome}).`);
  return BigInt(m[1] + (m[2] || '').padEnd(ESCALA_PRECO, '0'));
}

function tokens(n, nome) {
  if (!Number.isInteger(n) || n < 0) throw E.invalid(`Quantidade de tokens inválida (${nome}).`);
  return BigInt(n);
}

function computeRunCost({ tokensIn = 0, tokensOut = 0, priceIn = '0', priceOut = '0' } = {}) {
  const total = tokens(tokensIn, 'entrada') * precoEmUnidades(priceIn, 'entrada') + tokens(tokensOut, 'saída') * precoEmUnidades(priceOut, 'saída');
  const passo = 10n ** BigInt(ESCALA_PRECO - ESCALA_CUSTO);
  const micro = (total + passo / 2n) / passo;
  const inteiro = micro / 10n ** BigInt(ESCALA_CUSTO);
  const frac = String(micro % 10n ** BigInt(ESCALA_CUSTO)).padStart(ESCALA_CUSTO, '0');
  return `${inteiro}.${frac}`;
}

module.exports = { computeRunCost };
