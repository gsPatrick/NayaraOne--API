'use strict';

const { mktExportForbidden } = require('../marketing.errors');

/**
 * M9-D433 — "lista exportada não é requisito para campanha interna": nenhuma rota do Marketing exporta destinatários (CSV, Excel, API em massa). O pedido que parece
 * exportação (caminho com export/download/csv/xlsx ou formato csv/xlsx/xls/json-lines no parâmetro) é recusado com 403 MKT_EXPORT_FORBIDDEN antes de qualquer rota. A consulta de público
 * devolve só a contagem (M9-D412).
 */
const EXPORT_PATH = /\/(?:export|exportar|exportacao|download|csv|xlsx|xls)(?:\/|$|\.)|\.(?:csv|xlsx|xls|ndjson|jsonl)$/i;
const EXPORT_FORMAT = /^(?:csv|xlsx|xls|ndjson|jsonl)$/i;

function looksLikeExport(req) {
  const path = String(req.path || req.originalUrl || '').split('?')[0];
  const format = req.query && (req.query.format || req.query.formato || req.query.export);
  return EXPORT_PATH.test(path) || (typeof format === 'string' && (EXPORT_FORMAT.test(format) || format === 'true'));
}

function recipientExportGuard(req, res, next) {
  if (looksLikeExport(req)) return next(mktExportForbidden({ path: String(req.path || '').split('?')[0] }));
  return next();
}

module.exports = { recipientExportGuard, looksLikeExport };
