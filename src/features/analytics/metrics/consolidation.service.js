'use strict';

/**
 * M9-D625 — consolidado do grupo calculado SÓ na leitura (BI-004): `GET /analytics/metrics/:code?groupId=...`. O ledger e os read models seguem
 * por empresa; aqui soma-se o valor de cada empresa permitida ao usuário e elimina-se o intercompany (os dois lados das transferências inteiras do
 * grupo). Sem escrita, sem linha consolidada em lugar nenhum. Resposta: `value`, `byCompany[]`, `eliminations` (total eliminado) e `consolidatedStatus`;
 * `value` = soma de `byCompany` menos `eliminations` (taxa: numerador e denominador somados, nunca a média das taxas).
 *
 * Ordem das recusas: grupo que não é o da sessão 404 ANALYTICS_SCOPE_NOT_FOUND; sem `analytics:read:group` 403 ANALYTICS_GROUP_SCOPE_FORBIDDEN;
 * indicador inexistente 404 ANALYTICS_METRIC_NOT_FOUND; indicador que não se soma 422 ANALYTICS_METRIC_NOT_CONSOLIDATABLE; nenhuma empresa alcançável 403
 * PERMISSION_DENIED. Par intercompany incompleto: 200 com consolidatedStatus DEGRADED, código ANALYTICS_INTERCOMPANY_UNMATCHED e details.unmatchedIntercompany.
 */
const AppError = require('../../../utils/AppError');
const { denied, domainPermissionOf, loadDomainMap } = require('../security');
const { findDefinition } = require('./registry.read');
const { getConsolidationRule } = require('./consolidation/rules');
require('./consolidation/rules.finance');
const { assertGroupScope, permittedCompanies, listGroupCompanies, inCompany } = require('./consolidation/companyAccess');
const { readCompanies } = require('./consolidation/companyKpi');
const { loadPairs } = require('./consolidation/intercompany');
const { consolidate } = require('./consolidation/compute');

const UNMATCHED_MESSAGE = 'Há transferências entre empresas sem contrapartida; o consolidado está incompleto.';
const PARTIAL_MESSAGE = 'Consolidado só das empresas permitidas.';

function dimensionKeysOf(rule) {
  return rule.kind === 'RATE' ? [rule.numeratorDimension, rule.denominatorDimension] : [];
}

/** A definição do indicador pode ser global ou da empresa: procura na sessão e depois em cada empresa do grupo (só o domínio dela é usado). */
async function resolveDefinition(ctx, metricCode, transaction) {
  const notFound = (err) => err.code === 'ANALYTICS_METRIC_NOT_FOUND';
  try {
    return await findDefinition(metricCode, transaction);
  } catch (err) {
    if (!notFound(err)) throw err;
  }
  for (const company of await listGroupCompanies(ctx.groupId, transaction)) {
    try {
      return await inCompany(company.id, ctx.companyId, transaction, () => findDefinition(metricCode, transaction));
    } catch (err) {
      if (!notFound(err)) throw err;
    }
  }
  throw AppError.notFound('Indicador não encontrado.', 'ANALYTICS_METRIC_NOT_FOUND');
}

/** ctx = { groupId, companyId, actorUserId, permissions }; input = { metricCode, groupId, asOfDate }. */
async function consolidateMetric(ctx, input, transaction) {
  assertGroupScope(ctx, input.groupId);
  const definition = await resolveDefinition(ctx, input.metricCode, transaction);
  const rule = getConsolidationRule(input.metricCode);
  if (!rule || rule.kind === 'NONE') {
    throw AppError.unprocessable('Este indicador não é somado no consolidado do grupo.', 'ANALYTICS_METRIC_NOT_CONSOLIDATABLE', { metricCode: input.metricCode, reason: rule ? rule.reason || null : null });
  }
  const { allowed, total } = await permittedCompanies(ctx, definition.domain, transaction);
  if (!allowed.length) throw denied(domainPermissionOf(await loadDomainMap(ctx, transaction), definition.domain));
  const byCompany = await readCompanies(ctx, allowed, input.metricCode, input.asOfDate, dimensionKeysOf(rule), transaction);
  const pairs = rule.intercompany ? await loadPairs(ctx, allowed.map((c) => c.id), transaction) : [];
  const result = consolidate(rule, byCompany, pairs, { asOfDate: input.asOfDate });
  const unmatched = result.unmatched;
  const times = byCompany.map((c) => c.sourceSnapshotAt).filter(Boolean).map((d) => new Date(d).getTime());
  return {
    metricCode: input.metricCode, scope: 'GROUP', groupId: ctx.groupId, asOfDate: input.asOfDate, unit: result.unit,
    value: result.value, byCompany: byCompany.map(({ dimensions, period, ...company }) => company), eliminations: result.eliminations, eliminatedTransfers: result.eliminatedPairs,
    consolidatedStatus: result.consolidatedStatus, status: result.consolidatedStatus,
    ...(unmatched.length ? { code: 'ANALYTICS_INTERCOMPANY_UNMATCHED', message: UNMATCHED_MESSAGE } : {}),
    details: { unmatchedIntercompany: unmatched, companiesIncluded: allowed.length, companiesInGroup: total, ...(result.numerator !== undefined ? { numerator: result.numerator, denominator: result.denominator } : {}) },
    warnings: allowed.length < total ? [{ code: 'ANALYTICS_CONSOLIDATED_PARTIAL', message: PARTIAL_MESSAGE, companiesIncluded: allowed.length, companiesInGroup: total }] : [],
    sourceSnapshotAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
  };
}

module.exports = { consolidateMetric, UNMATCHED_MESSAGE, PARTIAL_MESSAGE };
