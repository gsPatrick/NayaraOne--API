'use strict';

const { safeText } = require('./cells');

const BOM = String.fromCharCode(0xfeff);
const quote = (text, separator) => (/["\r\n]/.test(text) || text.includes(separator) ? `"${text.replace(/"/g, '""')}"` : text);

/**
 * CSV com BOM (o Excel em português lê os acentos). Com marca d'água: coluna técnica `_wm` em toda linha e, no fim, a linha de comentário da marca (M9-D822 §3.2 item 4).
 * `watermark` = { column: texto da coluna, line: linha final } ou null.
 */
function renderCsv({ columns, rows, separator, watermark }) {
  const head = columns.map((c) => quote(safeText(c.label), separator));
  if (watermark) head.push('_wm');
  const lines = [head.join(separator)];
  for (const row of rows) {
    const cells = columns.map((c) => quote(safeText(row[c.key], c.numeric), separator));
    if (watermark) cells.push(quote(safeText(watermark.column), separator));
    lines.push(cells.join(separator));
  }
  if (watermark) lines.push(watermark.line);
  return Buffer.from(`${BOM}${lines.join('\n')}\n`, 'utf8');
}

/** Arquivo pronto (DIMOB): só acrescenta a linha final da marca d'água, sem tocar no leiaute. */
function stampReadyCsv(text, watermark) {
  if (!watermark) return Buffer.from(text, 'utf8');
  return Buffer.from(`${text.replace(/\n*$/, '\n')}${watermark.line}\n`, 'utf8');
}

module.exports = { renderCsv, stampReadyCsv };
