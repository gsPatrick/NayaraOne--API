'use strict';

/**
 * Tokens de posição das fontes.
 *  - CDC: inteiro decimal sem sinal, monotônico (LSN/binlog/sequência convertidos pelo conector). Compara-se como número inteiro grande.
 *  - WATERMARK: `<instante UTC com microssegundos>|<chave>`, ex.: 2026-10-27T02:00:00.000000Z|5000 (largura fixa: a ordem do texto é a ordem do tempo).
 */
const CDC_RE = /^\d{1,30}$/;
const MICROS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const isCdcToken = (token) => typeof token === 'string' && CDC_RE.test(token);
const compareCdc = (a, b) => { const x = BigInt(a); const y = BigInt(b); return x < y ? -1 : (x > y ? 1 : 0); };

/** Date ou texto ISO -> `YYYY-MM-DDTHH:MM:SS.ffffffZ` (texto já nesse formato passa intacto). */
function isoMicros(value) {
  if (typeof value === 'string' && MICROS_RE.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('instante inválido');
  return `${date.toISOString().slice(0, 23)}000Z`;
}

const watermarkToken = (updatedAt, key) => `${isoMicros(updatedAt)}|${key}`;
function parseWatermark(token) {
  const at = String(token).indexOf('|');
  if (at < 1) return null;
  const ts = token.slice(0, at);
  return MICROS_RE.test(ts) ? { ts, key: token.slice(at + 1) } : null;
}
function compareWatermark(a, b) {
  const x = parseWatermark(a); const y = parseWatermark(b);
  if (x.ts !== y.ts) return x.ts < y.ts ? -1 : 1;
  if (x.key === y.key) return 0;
  return x.key < y.key ? -1 : 1;
}

/** Recua o instante do token em `seconds` segundos (a sobreposição do watermark). */
function minusSeconds(ts, seconds) {
  return isoMicros(new Date(new Date(ts).getTime() - Number(seconds) * 1000));
}

module.exports = { isCdcToken, compareCdc, isoMicros, watermarkToken, parseWatermark, compareWatermark, minusSeconds };
