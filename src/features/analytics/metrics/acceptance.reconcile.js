'use strict';

/**
 * M9-D708 (3.3) — reconciliação de um KPI: o valor do BI (snapshot da versão atual na data-base) contra o do relatório de referência, a diferença
 * (BI menos relatório) e a tolerância vigente, gravados em analytics.metric_acceptance como PENDING. Quem decide é o owner (acceptance.service).
 * `options`: { asOfDate, now, referenceReports } (referenceReports vem de scripts/analytics/reconcile/reports.js). Roda na transação do chamador.
 */
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const store = require('../metricStore.service');
const clock = require('./clock');
const money = require('./formulas/money');
const { findDefinition } = require('./registry.read');
const acceptanceStore = require('./acceptance.store');
const { ownerUserIds } = require('./acceptance.owner');
const { hasReference, resolveReference } = require('./acceptance.reference');
const { publishedWithAcceptance } = require('./acceptance.environment');
const { readTolerance, toleranceFor } = require('./acceptance.settings');

const PLACES = (unit) => (unit === 'COUNT' ? 0 : 2);
/** Valor como o livro mostra: contagem inteira; o resto com 2 casas. */
const shown = (value, unit) => (value === null || value === undefined ? null : money.round(String(value), PLACES(unit)));

async function currentVersion(definition, transaction) {
  const rows = await sequelize.query('SELECT * FROM analytics.metric_versions WHERE id = :id', { type: QueryTypes.SELECT, replacements: { id: definition.current_version_id }, transaction });
  return rows[0] || null;
}

async function latestSnapshot(ctx, definition, version, asOfDate, transaction) {
  const scope = definition.group_scoped ? { scopeType: 'GROUP', scopeId: ctx.groupId } : { scopeType: 'COMPANY', scopeId: ctx.companyId };
  const revisions = await store.listSnapshotRevisions({ metricId: definition.id, metricVersionId: version.id, ...scope, asOfDate, dimensionKey: '' }, transaction);
  return revisions[revisions.length - 1] || null;
}

/** Reconcilia uma métrica publicada da empresa e grava a linha PENDING da versão atual. Devolve { metricCode, version, biValue, referenceValue, difference, tolerance, status, referenceReport, comment }. */
async function reconcileMetric(ctx, metricCode, options = {}, transaction) {
  const definition = await findDefinition(String(metricCode), transaction);
  if (definition.status !== 'PUBLISHED' || !definition.current_version_id) {
    throw AppError.conflict('Só indicador publicado é reconciliado.', 'ANALYTICS_METRIC_NOT_PUBLISHED', { metricCode, status: definition.status });
  }
  const version = await currentVersion(definition, transaction);
  const asOfDate = options.asOfDate || clock.businessToday();
  const snapshot = await latestSnapshot(ctx, definition, version, asOfDate, transaction);
  const biRaw = snapshot && snapshot.value_numeric != null ? String(snapshot.value_numeric) : null;
  const reference = await resolveReference(ctx, definition, version, snapshot, { ...options, asOfDate }, transaction);
  const biValue = shown(biRaw, version.unit);
  const referenceValue = shown(reference.value, version.unit);
  const difference = biValue !== null && referenceValue !== null ? shown(money.toString(money.sub(biValue, referenceValue)), version.unit) : null;
  const comment = [biValue === null ? `Sem valor do BI na data-base ${asOfDate} (nenhum snapshot da versão ${version.version}).` : null, reference.comment].filter(Boolean).join(' ') || null;
  const tolerance = toleranceFor(await readTolerance(ctx, transaction), version.unit);
  const owners = await ownerUserIds(definition, ctx.companyId, transaction);
  const referenceReport = `${(version.quality_rule || {}).referenceReport || 'Relatório de referência não informado'} | ${reference.label}`;
  const before = await acceptanceStore.find(ctx.companyId, metricCode, version.version, transaction);
  const row = await acceptanceStore.upsertReconciliation(ctx, {
    metricCode, version: version.version, ownerUserId: owners.length === 1 ? owners[0] : null, referenceReport, referenceValue, biValue, difference, tolerance, comment,
  }, transaction);
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.actorUserId || null, action: 'analytics.metric.reconciled', entityType: 'analytics.metric_acceptance', entityId: row.id,
    beforeJson: before ? { status: before.status, biValue: before.biValue, referenceValue: before.referenceValue, difference: before.difference } : null,
    afterJson: { metricCode, version: version.version, status: 'PENDING', biValue, referenceValue, difference, tolerance, asOfDate },
    reason: `Reconciliação de ${metricCode} (versão ${version.version}) com o relatório de referência.`,
  }, transaction);
  return { metricCode, version: version.version, unit: version.unit, biValue, referenceValue, difference, tolerance, status: 'PENDING', referenceReport, comment, asOfDate };
}

/** Reconcilia todas as métricas publicadas visíveis à empresa (uma por código). */
async function reconcileAll(ctx, options = {}, transaction) {
  const published = await publishedWithAcceptance(ctx.companyId, transaction);
  const out = [];
  for (const m of published) out.push(await reconcileMetric(ctx, m.code, options, transaction));
  return out;
}

module.exports = { reconcileMetric, reconcileAll, hasReference };
