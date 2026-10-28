'use strict';

/**
 * M9-D605 (3.2) — datas de calendário nas fórmulas: prazos em dias são a diferença de datas AAAA-MM-DD (inteiro), sem relógio.
 * A data "hoje" entra sempre como parâmetro (asOfDate), calculada fora da fórmula no calendário de São Paulo.
 */
const { inputInvalid } = require('../formulaErrors');

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayNumber(text) {
  const m = DATE_RE.exec(String(text));
  if (!m) throw inputInvalid();
  const ms = Date.UTC(Number.parseInt(m[1], 10), Number.parseInt(m[2], 10) - 1, Number.parseInt(m[3], 10));
  const check = new Date(ms);
  if (check.getUTCDate() !== Number.parseInt(m[3], 10)) throw inputInvalid(); // 30/02 e semelhantes
  return ms / 86400000;
}

/** Dias corridos de `from` até `to` (negativo se `to` for anterior). */
function daysBetween(from, to) {
  return dayNumber(to) - dayNumber(from);
}

module.exports = { daysBetween };
