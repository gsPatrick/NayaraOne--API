'use strict';

/**
 * Custo em reais com 6 casas, só com inteiros (BigInt): nada de ponto flutuante em dinheiro. Preço = reais por milhão de tokens
 * (aceita número ou texto, até 6 casas). 1.000 tokens a R$ 5,00 por milhão = 0,005000. Arredonda meio para cima na 6ª casa.
 */
const SCALE = 1000000n;
const PRICE_RE = /^\d{1,9}(?:[.,]\d{1,6})?$/;

/** Preço em micro-reais por milhão de tokens (inteiro BigInt) ou null se inválido. */
function priceToScaled(price) {
  const text = typeof price === 'number' ? (Number.isFinite(price) ? price.toFixed(6) : '') : String(price ?? '').trim();
  if (!PRICE_RE.test(text) || text.startsWith('-')) return null;
  const [inteiro, fracao = ''] = text.replace(',', '.').split('.');
  return BigInt(inteiro) * SCALE + BigInt(fracao.padEnd(6, '0'));
}

/** Custo da chamada em micro-reais (Number inteiro): (tokensIn x preçoIn + tokensOut x preçoOut) / 1.000.000. */
function costMicros({ tokensIn = 0, tokensOut = 0, pricePerMTokIn = 0, pricePerMTokOut = 0 }) {
  const pin = priceToScaled(pricePerMTokIn);
  const pout = priceToScaled(pricePerMTokOut);
  if (pin === null || pout === null) throw new TypeError('preço por milhão de tokens inválido');
  const total = BigInt(Math.max(0, Math.trunc(tokensIn))) * pin + BigInt(Math.max(0, Math.trunc(tokensOut))) * pout;
  return Number((total + SCALE / 2n) / SCALE);
}

/** micro-reais -> texto com 6 casas ("0.005000"). */
const microsToAmount = (micros) => `${Math.floor(micros / 1000000)}.${String(micros % 1000000).padStart(6, '0')}`;
const amountToMicros = (amount) => Number(priceToScaled(amount));

const costAmount = (usage, prices) => microsToAmount(costMicros({ tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, ...prices }));

module.exports = { priceToScaled, costMicros, microsToAmount, amountToMicros, costAmount };
