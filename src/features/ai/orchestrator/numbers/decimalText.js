'use strict';

// M9-D026 — leitura e escrita de números em texto pt-BR sobre aritmética decimal EXATA (BigInt escalado, o mesmo utilitário do BI,
// M9-D605). Nada aqui usa ponto flutuante: "18.432,50" vira o texto decimal "18432.5" e nunca um Number.

const decimal = require('../../../analytics/metrics/formulas/money');

const SCALES = Object.freeze({
  mil: 1000, k: 1000, mi: 1000000, milhao: 1000000, milhoes: 1000000, bi: 1000000000, bilhao: 1000000000, bilhoes: 1000000000,
});

const semAcento = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Texto numérico pt-BR (ou com ponto decimal) -> texto decimal canônico ("18.432,50" -> "18432.5"); null se não for número. */
function parseNumberText(raw) {
  const s = String(raw).trim();
  let plain;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) plain = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d+(,\d+)?$/.test(s)) plain = s.replace(',', '.');
  else if (/^\d+(\.\d+)?$/.test(s)) plain = s;
  else return null;
  return canonical(plain);
}

/** Tira zeros à esquerda e à direita: "0018.500" -> "18.5"; "10.00" -> "10". */
function canonical(text) {
  let [int, frac = ''] = String(text).replace(/^-/, '').split('.');
  int = int.replace(/^0+(?=\d)/, '') || '0';
  frac = frac.replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

/** Aplica "mil", "milhões" etc. ao número (exato). */
function scaled(value, word) {
  const factor = SCALES[semAcento(word)];
  return factor ? canonical(decimal.toString(decimal.mul(value, factor))) : value;
}

/** Igualdade numérica exata entre dois textos decimais. */
function sameNumber(a, b) {
  try { return decimal.cmp(a, b) === 0; } catch (e) { return false; }
}

/** Soma exata de textos decimais (sem float): "1000.10" + "2000.20" = "3000.30". */
function sumExact(values, places = 2) {
  return decimal.round(decimal.sum(values.map((v) => decimal.dec(String(v)))), places);
}

/** Texto decimal -> pt-BR com `places` casas, meio para cima uma vez ("18432.5" -> "18.432,50"). */
function formatPtBr(value, places = 2) {
  const fixed = decimal.round(decimal.dec(String(value)), places);
  const negative = fixed.startsWith('-');
  const [int, frac] = fixed.replace('-', '').split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : ''}${grouped}${frac ? `,${frac}` : ''}`;
}

/** Proporção (0,12) -> percentual exato como texto decimal ("12"), sem float na multiplicação. */
function fractionToPercent(fraction) {
  return canonical(decimal.toString(decimal.mul(Number(fraction).toFixed(4), 100)));
}

const isDecimalText = (v) => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim());

module.exports = { parseNumberText, canonical, scaled, sameNumber, sumExact, formatPtBr, fractionToPercent, isDecimalText, semAcento, SCALES };
