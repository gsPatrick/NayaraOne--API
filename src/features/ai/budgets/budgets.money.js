'use strict';

/** Dinheiro do orçamento em BigInt na escala de 1e6 (seis casas), sem ponto flutuante. Valores entram e saem como texto decimal. */
const SCALE = 6;

function toMicro(value) {
  const text = typeof value === 'number' ? value.toFixed(SCALE) : String(value ?? '0').trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,12}))?$/.exec(text);
  if (!m) throw new TypeError(`Valor monetário inválido: ${text}`);
  const frac = (m[3] || '').padEnd(12, '0');
  const micro = BigInt(m[2]) * 10n ** 6n + (BigInt(frac.slice(0, 6)) + (BigInt(frac.slice(6)) * 2n >= 10n ** 6n ? 1n : 0n));
  return m[1] ? -micro : micro;
}

function fromMicro(micro) {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  return `${negative ? '-' : ''}${abs / 10n ** 6n}.${String(abs % 10n ** 6n).padStart(SCALE, '0')}`;
}

/** consumido >= pct% do limite (comparação exata). */
const reaches = (consumed, limit, pct) => toMicro(consumed) * 100n >= BigInt(pct) * toMicro(limit);

/** Porcentagem consumida com duas casas (truncada, para nunca mostrar 100,00 antes de chegar a 100). */
function pctOf(consumed, limit) {
  const l = toMicro(limit);
  if (l <= 0n) return '0.00';
  const hundredths = (toMicro(consumed) * 10000n) / l;
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`;
}

/** Estimativa máxima do custo: maxInput x preço de entrada + maxOutput x preço de saída (preço por token, texto decimal). */
function estimateCost({ maxInput = 0, maxOutput = 0, priceIn = '0', priceOut = '0' }) {
  const unit = (v) => {
    const m = /^(\d+)(?:\.(\d{1,12}))?$/.exec(String(v).trim());
    if (!m) throw new TypeError(`Preço por token inválido: ${v}`);
    return BigInt(m[1] + (m[2] || '').padEnd(12, '0'));
  };
  const total = BigInt(maxInput) * unit(priceIn) + BigInt(maxOutput) * unit(priceOut);
  const step = 10n ** 6n;
  return fromMicro((total + step / 2n) / step);
}

/** Texto decimal com seis casas. */
const normalize = (value) => fromMicro(toMicro(value));

module.exports = { toMicro, fromMicro, normalize, reaches, pctOf, estimateCost };
