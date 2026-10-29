'use strict';

const RESTRICTED = 'RESTRICTED';

/**
 * Máscara de coluna (M9-D822 §3.2 item 6): a coluna RESTRICTED sai com o texto de máscara (FULL) para quem não pode ver em claro; as demais colunas não mudam. Enquanto o
 * registro de classificação (M9-D910/D915) não existe, a classe vem do catálogo da exportação. Devolve { rows, maskedColumns }.
 */
function maskRows(columns, rows, { canViewRestricted, maskText }) {
  const masked = canViewRestricted ? [] : columns.filter((c) => c.classification === RESTRICTED).map((c) => c.key);
  if (!masked.length) return { rows, maskedColumns: [] };
  return { rows: rows.map((row) => ({ ...row, ...Object.fromEntries(masked.map((key) => [key, row[key] === null || row[key] === undefined || row[key] === '' ? row[key] : maskText])) })), maskedColumns: masked };
}

module.exports = { maskRows };
