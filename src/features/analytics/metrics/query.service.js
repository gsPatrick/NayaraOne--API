'use strict';

/**
 * M9-D702 (3.1 e 3.3) — GET /analytics/metrics/:code. Ordem das conferências: permissão `analytics:read` (403) -> parâmetros desconhecidos (400) ->
 * empresa/grupo (404) -> período e data-base (400) -> indicador publicado (404 "Indicador não encontrado.") -> permissão do domínio (403) -> dimensão e
 * comparação (400) -> leitura do snapshot. Somente leitura: roda na transação READ ONLY do router (M9-D612) e só grava o log de acesso do indicador CRITICAL
 * (transação própria, M9-D700). O valor vem sempre do registro de métricas; nunca é calculado nem refeito aqui.
 */
const AppError = require('../../../utils/AppError');
const { assertCanRead } = require('./registry.permission');
const { findDefinition } = require('./registry.read');
const { readMetricAsOf } = require('./registry.asOf');
const { consolidateMetric } = require('./consolidation.service');
const { METRIC_PARAMS, assertKnownParams } = require('./query.params');
const { resolveQueryPeriod, periodView } = require('./query.period');
const { assertCompareKind, buildVariation } = require('./query.compare');
const { resolveDimension, readBreakdown, keyOf } = require('./query.dimension');
const { presentMetric } = require('./query.present');
const { loadDomainMap, assertDomainAccess, recordAccess } = require('../security');

const notFound = () => AppError.notFound('Indicador não encontrado.', 'ANALYTICS_METRIC_NOT_FOUND');

/** O BI lê pela empresa da sessão: qualquer outra (de outro grupo, sem vínculo ou até do mesmo grupo) responde 404, nunca 403 nem 400, e não revela se existe (DI-D702-1). */
function sessionCompany(ctx, requested) {
  if (requested === undefined || requested === '' || requested === ctx.companyId) return ctx.companyId;
  throw AppError.notFound('Empresa não encontrada ou sem acesso.', 'ANALYTICS_SCOPE_NOT_FOUND');
}

/** Definição visível ao BI: existe e está PUBLISHED. Inexistente e não publicada respondem igual (404), sem revelar a diferença. */
async function findPublishedDefinition(code, transaction) {
  let definition;
  try {
    definition = await findDefinition(String(code), transaction);
  } catch (err) {
    if (err && err.code === 'ANALYTICS_METRIC_NOT_FOUND') throw notFound();
    throw err;
  }
  if (definition.status !== 'PUBLISHED') throw notFound();
  return definition;
}

async function consolidated(ctx, code, query, asOfDate, period, transaction) {
  if (query.dimension !== undefined || query.dimensionValue !== undefined) throw AppError.badRequest('Dimensão inválida para este indicador.', 'ANALYTICS_DIMENSION_INVALID');
  assertCompareKind(query.compareTo);
  if (query.compareTo !== undefined && query.compareTo !== '') throw AppError.badRequest('A comparação não vale para o consolidado do grupo.', 'ANALYTICS_COMPARE_INVALID');
  const data = await consolidateMetric(ctx, { metricCode: code, groupId: query.groupId, asOfDate }, transaction);
  return { ...data, period: periodView(period, asOfDate) };
}

async function readMetricResponse(ctx, code, query, { ip = null, route = null } = {}, transaction) {
  assertCanRead(ctx);
  assertKnownParams(query, METRIC_PARAMS);
  const companyId = sessionCompany(ctx, query.companyId);
  const { period, asOfDate } = resolveQueryPeriod(query);
  if (query.groupId !== undefined) return consolidated(ctx, code, query, asOfDate, period, transaction);
  const definition = await findPublishedDefinition(code, transaction);
  await assertDomainAccess(ctx, definition.domain, transaction);
  const compareKind = assertCompareKind(query.compareTo);
  const dimension = await resolveDimension({ definition, query, asOfDate }, transaction);
  const dimensionKey = dimension && dimension.dimensionValue !== undefined ? keyOf(dimension) : '';
  const raw = await readMetricAsOf(ctx, { metricCode: definition.metric_code, scopeType: 'COMPANY', scopeId: companyId, asOfDate, dimensionKey }, transaction);
  const variation = compareKind ? await buildVariation({ ctx, definition, companyId, kind: compareKind, period, asOfDate, unit: raw.unit }, transaction) : null;
  const domainMap = await loadDomainMap(ctx, transaction);
  const data = presentMetric({ ctx, definition, raw, period, asOfDate, domainMap, variation });
  if (dimension) data.dimension = { code: dimension.dimension, value: dimension.dimensionValue === undefined ? null : dimension.dimensionValue };
  if (dimension && dimension.dimensionValue === undefined) data.breakdown = await readBreakdown({ ctx, definition, companyId, dimension: dimension.dimension, asOfDate }, transaction);
  if (definition.criticality === 'CRITICAL') { // M9-D702 6: log de acesso das métricas CRITICAL (o painel tem o seu, M9-D687)
    await recordAccess({ ...ctx, companyId }, {
      action: 'METRIC_READ', resourceType: 'METRIC', resourceCode: definition.metric_code, route, ip, filters: { period: periodView(period, asOfDate), dimension: dimension || undefined }, rowsReturned: 1,
    });
  }
  return data;
}

module.exports = { readMetricResponse, findPublishedDefinition };
