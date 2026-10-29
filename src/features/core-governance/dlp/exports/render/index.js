'use strict';

const { renderCsv, stampReadyCsv } = require('./csv');
const { renderXlsx } = require('./xlsx');
const { renderPdf } = require('./pdf');
const { fillTemplate } = require('../export.settings');

const MIME = Object.freeze({
  CSV: 'text/csv',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  PDF: 'application/pdf',
});

/**
 * Monta o arquivo no formato pedido. `watermark` = { enabled, vars: {usuario, data, job}, text, csvText } com os modelos dos parâmetros; `separator` do CSV.
 * Arquivo pronto (`ready`, DIMOB) só recebe a linha final da marca d'água. Devolve { buffer, mimeType, extension }.
 */
async function renderFile({ format, entry, columns, rows, ready, watermark, separator, now }) {
  const marks = watermark && watermark.enabled ? { text: fillTemplate(watermark.text, watermark.vars), line: fillTemplate(watermark.csvText, watermark.vars) } : null;
  if (ready) return { buffer: stampReadyCsv(ready.text, marks && { line: marks.line }), mimeType: MIME.CSV, extension: 'csv' };
  if (format === 'CSV') return { buffer: renderCsv({ columns, rows, separator, watermark: marks && { column: marks.text, line: marks.line } }), mimeType: MIME.CSV, extension: 'csv' };
  if (format === 'XLSX') return { buffer: renderXlsx({ columns, rows, watermarkText: marks && marks.text, title: entry.label }), mimeType: MIME.XLSX, extension: 'xlsx' };
  return { buffer: await renderPdf({ columns, rows, title: entry.label, watermarkText: marks && marks.text, generatedAt: now }), mimeType: MIME.PDF, extension: 'pdf' };
}

module.exports = { renderFile, MIME };
