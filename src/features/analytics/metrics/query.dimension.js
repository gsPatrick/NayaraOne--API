'use strict';

/**
 * M9-D702 (3.1 e 3.3) — `dimension` e `dimensionValue`. A dimensão precisa estar declarada na versão da métrica vigente na data-base
 * (400 ANALYTICS_DIMENSION_INVALID). Só `dimension`: a resposta traz a decomposição (`breakdown`) além do valor principal. Com
 * `dimensionValue`: o valor passa a ser o do recorte (chave `dimensão=valor` do snapshot); recorte sem registro é 404 ANALYTICS_SNAPSHOT_NOT_AVAILABLE.
 */
const AppError = require('../../../utils/AppError');
const metricStore = require('../metricStore.service');
const nayStore = require('../nayReadStore.service');
const { readDimensionMaxItems } = require('./query.settings');

const invalid = () => AppError.badRequest('Dimensão inválida para este indicador.', 'ANALYTICS_DIMENSION_INVALID');
const codeOf = (d) => (typeof d === 'string' ? d : d && d.code);
const text = (v) => (v === undefined || v === '' ? undefined : v);

/** { dimension, dimensionValue } normalizados e conferidos contra a versão; null quando a consulta não pede dimensão. */
async function resolveDimension({ definition, query, asOfDate }, transaction) {
  const dimension = text(query.dimension);
  const value = text(query.dimensionValue);
  if (dimension === undefined && value === undefined) return null;
  if (dimension === undefined || typeof dimension !== 'string' || (value !== undefined && typeof value !== 'string')) throw invalid();
  const version = await metricStore.getMetricVersionAt(definition.id, asOfDate, transaction);
  const declared = version && Array.isArray(version.dimensions) ? version.dimensions.map(codeOf) : [];
  if (!declared.includes(dimension)) throw invalid();
  return { dimension, dimensionValue: value };
}

/** Decomposição por valor da dimensão na data-base: { dimension, items: [{ dimensionValue, value, status }], truncated }. */
async function readBreakdown({ ctx, definition, companyId, dimension, asOfDate }, transaction) {
  const max = await readDimensionMaxItems(ctx, transaction);
  const found = await nayStore.listDimensionSnapshots({ metricId: definition.id, companyId, asOfDate, dimension, limit: max + 1 }, transaction);
  const items = found.slice(0, max).map((s) => ({
    dimensionValue: s.dimensionKey.slice(dimension.length + 1),
    value: s.value_numeric !== null && s.value_numeric !== undefined ? String(s.value_numeric) : s.value_text,
    status: s.status,
  }));
  return { dimension, items, truncated: found.length > max };
}

const keyOf = ({ dimension, dimensionValue }) => `${dimension}=${dimensionValue}`;

module.exports = { resolveDimension, readBreakdown, keyOf };
