'use strict';

/**
 * M9-D690 — detalhe (drill-down) de um indicador do BI até os registros autorizados. Quatro verificações, nesta ordem:
 *   1. escopo: a empresa pedida é do grupo e visível à sessão (senão 404 ANALYTICS_SCOPE_NOT_FOUND, sem revelar existência);
 *   2. métrica: existe, está PUBLISHED e é CRITICAL ou tem drilldown_enabled (senão 409 ANALYTICS_DRILLDOWN_NOT_AVAILABLE);
 *   3. permissão de detalhe: o filtro assinado é aberto por `openSourceDetail` (M9-D611: hash ou assinatura adulterados dão 400
 *      ANALYTICS_FILTER_HASH_INVALID; falta de analytics:drilldown ou da permissão do domínio dá 403 ANALYTICS_DRILLDOWN_FORBIDDEN e a
 *      resposta traz só o AGREGADO permitido, sem linhas);
 *   4. campo a campo: as linhas saem por `prepareSecureRows` (M9-D700): RESTRICTED mascarado e linha DRILLDOWN no log de acesso.
 * Leitura pura: nenhuma escrita no OLTP. O detalhe é paginado (máximo em analytics.drilldown.tamanho_pagina_maximo).
 */
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { P, prepareSecureRows, recordAccess, resolveCompanyScope } = require('../security');
const { getSourceSpec } = require('./sourceRefs.spec');
const { verifyFilter } = require('./sourceRefs.filter');
const { openSourceDetail } = require('./sourceRefs.detail');
const { metricContext, modeOf } = require('./sourceRefs.build');
const { filterHashInvalid } = require('./sourceRefs.errors');
const { readPageLimits } = require('./drilldown.settings');
const { pageRows, aggregateOf } = require('./drilldown.rows');
const { drilldownNotAvailable, pageSizeInvalid, pageInvalid, componentRequired, metricNotFound } = require('./drilldown.errors');
require('./drilldown.details.finance');
require('./drilldown.details.obras.custo'); // M9-D650
require('./drilldown.details.obras.operacao'); // M9-D651

const toInt = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : (/^\d+$/.test(String(v)) ? Number(v) : NaN));

async function findDefinition(code, transaction) {
  const [rows] = await sequelize.query(
    `SELECT metric_code, domain, status, criticality, drilldown_enabled FROM analytics.metric_definitions
      WHERE metric_code = :code ORDER BY (company_id IS NULL), (group_id IS NULL) LIMIT 1`,
    { replacements: { code }, transaction }
  );
  return rows[0] || null;
}

/** KPI composto (M9-D611 3.5) abre o detalhe de UM componente por vez (`component`); KPI simples abre o próprio. */
function sourceCodeOf(input) {
  const spec = getSourceSpec(input.metricCode);
  if (!spec || !spec.components) return input.metricCode;
  const chosen = getSourceSpec(input.component || '');
  if (!input.component || !spec.components.includes(input.component) || !chosen || chosen.components) throw componentRequired(spec.components);
  return input.component;
}

function parseFilter(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch (_e) { throw filterHashInvalid(); }
}

async function logDenied(ctx, input) {
  await recordAccess(ctx, {
    action: 'DRILLDOWN', resourceType: 'METRIC', resourceCode: input.logCode, route: input.route, ip: input.ip, rowsReturned: 0,
    filters: { filterHash: input.filterHash, denied: true },
  });
}

/** 403 com o agregado permitido: o filtro já foi conferido (hash e assinatura) antes de chegar aqui. */
async function forbiddenWithAggregate(ctx, input, err, transaction) {
  const spec = getSourceSpec(input.metricCode);
  const filter = await verifyFilter(ctx.companyId, spec.table, { filter: input.filter, filterHash: input.filterHash, filterSignature: input.filterSignature });
  const aggregate = await aggregateOf(spec, filter, transaction);
  await logDenied(ctx, input);
  throw AppError.forbidden(err.message, err.code, { aggregate, metricCode: input.metricCode });
}

/**
 * ctx = { groupId, companyId, actorUserId, permissions }; input = { metricCode, companyId, component, filter, filterHash, filterSignature, page, pageSize,
 * ip, route }. Devolve { metricCode, companyId, description, reconcileMode, aggregate, page, pageSize, totalPages, rows, maskedCount }.
 */
async function openDrilldown(ctx, input, transaction) {
  const companyId = await resolveCompanyScope(ctx, input.companyId, transaction);
  const definition = await findDefinition(input.metricCode, transaction);
  if (!definition) throw metricNotFound();
  if (definition.status !== 'PUBLISHED' || !(definition.criticality === 'CRITICAL' || definition.drilldown_enabled)) throw drilldownNotAvailable();
  const limits = await readPageLimits(ctx, transaction);
  const page = toInt(input.page, 1);
  const pageSize = toInt(input.pageSize, limits.standard);
  if (!Number.isInteger(page) || page < 1) throw pageInvalid();
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > limits.max) throw pageSizeInvalid(limits.max);

  const sourceCode = sourceCodeOf(input);
  const request = { ...input, metricCode: sourceCode, filter: parseFilter(input.filter) };
  let detail;
  try {
    detail = await openSourceDetail(ctx, sourceCode, request, transaction, { limit: 1, domain: definition.domain });
  } catch (err) {
    if (err.code === 'ANALYTICS_DRILLDOWN_FORBIDDEN') await forbiddenWithAggregate(ctx, { ...request, logCode: input.metricCode }, err, transaction);
    throw err;
  }
  const spec = getSourceSpec(sourceCode);
  const filter = await verifyFilter(companyId, spec.table, request);
  const { unit } = await metricContext(sourceCode, { unit: (await metricContext(input.metricCode, {}, transaction)).unit }, transaction);
  const mode = modeOf(spec, unit);
  const { rows } = await pageRows(spec, filter, { mode, page, pageSize }, transaction);
  const secure = await prepareSecureRows(ctx, {
    permission: P.DRILLDOWN, domain: definition.domain, action: 'DRILLDOWN', resourceType: 'METRIC', resourceCode: input.metricCode, route: input.route,
    filters: { filterHash: input.filterHash, page, pageSize }, rows, ip: input.ip, transaction,
  });
  return {
    metricCode: input.metricCode, component: sourceCode === input.metricCode ? null : sourceCode, companyId, description: detail.description, reconcileMode: mode,
    aggregate: await aggregateOf(spec, filter, transaction), page, pageSize, totalPages: Math.max(1, Math.ceil(detail.count / pageSize)),
    rows: secure.rows, maskedCount: secure.maskedCount,
  };
}

module.exports = { openDrilldown, findDefinition, sourceCodeOf, parseFilter };
