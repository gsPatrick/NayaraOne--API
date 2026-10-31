'use strict';

const { getEntry } = require('./exports.catalog');
const errors = require('./export.errors');

/**
 * Valida o corpo de POST /exports na ordem do livro (M9-D822 §3.1 e §4): recurso do catálogo -> formato -> colunas -> filtro; nada é gravado antes. `allowedFormats` são os
 * formatos que a empresa aceita (parâmetro). Devolve { entry, format, columns, columnsListed, warnings: [], filter, purpose, justification, watermark }.
 */
function parseExportBody(body, allowedFormats) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw errors.bodyInvalid('Corpo da exportação inválido.');
  const entry = typeof body.resourceType === 'string' ? getEntry(body.resourceType) : null;
  if (!entry) throw errors.resourceInvalid();

  const format = typeof body.format === 'string' ? body.format.trim().toUpperCase() : '';
  if (!['CSV', 'XLSX', 'PDF'].includes(format) || !entry.formats.includes(format) || !allowedFormats.includes(format)) throw errors.formatInvalid({ allowed: entry.formats.filter((f) => allowedFormats.includes(f)) });

  const known = entry.columns.map((c) => c.key);
  let columns = known;
  let columnsListed = false;
  if (body.columns !== undefined && body.columns !== null) {
    if (!Array.isArray(body.columns) || body.columns.some((c) => typeof c !== 'string') || new Set(body.columns).size !== body.columns.length) throw errors.columnInvalid();
    const bad = body.columns.filter((c) => !known.includes(c));
    if (bad.length || (entry.fixedLayout && body.columns.length)) throw errors.columnInvalid({ columns: bad });
    if (body.columns.length) { columns = body.columns; columnsListed = true; }
  }

  if (body.watermark !== undefined && body.watermark !== null && typeof body.watermark !== 'boolean') throw errors.bodyInvalid('O campo "watermark" deve ser verdadeiro ou falso.', { field: 'watermark' });
  const filter = entry.parseFilter(body.filter);
  return {
    entry, format, columns, columnsListed, warnings: [], filter, purpose: typeof body.purpose === 'string' ? body.purpose : null, justification: typeof body.justification === 'string' ? body.justification : null,
    watermark: body.watermark === true,
  };
}

module.exports = { parseExportBody };
