'use strict';

const { KIND, CANCEL, SOURCE_KINDS } = require('./sources.constants');
const { getSetting } = require('../../../../features/settings/settings.service');
const settings = require('../calendar.settings');
const { upsertItem, closeExpiredItems, cancelStaleItems } = require('../calendar.projection.store');
const queries = require('./backfill.queries');
const construction = require('./construction.source');
const guarantee = require('./guarantee.source');
const { projectWarrantySourceId } = require('./ids');
const { dateKeyInZone, addMonthsToDateKey, dueFromDateValue } = require('./time');

/**
 * Carga inicial e varredura diária das fontes CONSTRUCTION e GUARANTEE (M9-D803 §3.4 e §3.2.1). Idempotente: reexecutar
 * não duplica (UPSERT por origem). Além de trazer os registros abertos que já existiam antes da ativação, a varredura
 *  1. fecha (DONE) o item PROJECT_WARRANTY cujo fim da garantia já passou, lendo só `calendar_items`;
 *  2. cancela o item aberto cuja origem não está mais aberta (obra cancelada, etapa/garantia/caso encerrado ou excluído).
 */
const STALE_KINDS = SOURCE_KINDS;
const STALE_REASON = CANCEL.SOURCE_NOT_OPEN;

async function readContext(tenant, transaction) {
  const severityMap = settings.parseSeverityMap(await getSetting(settings.SEVERITY_KEY, tenant, transaction, settings.CALENDAR_SETTING_DEFAULTS[settings.SEVERITY_KEY]));
  const months = Number(await getSetting(settings.WARRANTY_MONTHS_KEY, tenant, transaction, settings.CALENDAR_SETTING_DEFAULTS[settings.WARRANTY_MONTHS_KEY]));
  return { severityMap, warrantyMonths: months > 0 ? months : settings.CALENDAR_SETTING_DEFAULTS[settings.WARRANTY_MONTHS_KEY] };
}

/** Linhas de origem -> rascunhos de item (funções puras das fontes). */
function buildDrafts(rows, ctx, now) {
  const items = [];
  const push = (result) => items.push(...result.items);
  rows.stages.forEach((row) => push(construction.stageResult(row, ctx)));
  rows.projects.forEach((row) => push(construction.projectResult(row, ctx)));
  rows.guarantees.forEach((row) => push(guarantee.legalGuaranteeResult(row, ctx)));
  rows.cases.forEach((row) => push(guarantee.warrantyCaseResult({
    ...row, ...(['CRITICAL', 'OVERDUE'].includes(row.escalationLevel) ? { severity: 'CRITICAL' } : {}),
  }, ctx)));
  const keepWarranty = [];
  rows.warranties.forEach((row) => {
    keepWarranty.push(projectWarrantySourceId(row.projectId));
    const endsAt = row.warrantyEndsAt || addMonthsToDateKey(dateKeyInZone(row.startedAt), ctx.warrantyMonths);
    // Garantia já vencida não é reaberta: o item (se existir) é fechado pela varredura abaixo.
    if (dueFromDateValue(endsAt) < now) return;
    push(guarantee.projectWarrantyResult({ projectId: row.projectId, name: row.name, warrantyEndsAt: endsAt, responsibleUserId: row.responsibleUserId }, ctx));
  });
  return { items, keepWarranty };
}

async function runBackfill(tenant, transaction, now = new Date()) {
  const ctx = await readContext(tenant, transaction);
  const rows = {
    stages: await queries.openStages(tenant.companyId, transaction),
    projects: await queries.openProjects(tenant.companyId, transaction),
    guarantees: await queries.activeGuarantees(tenant.companyId, transaction),
    cases: await queries.openWarrantyCases(tenant.companyId, transaction),
    warranties: await queries.projectsInWarranty(tenant.companyId, transaction),
  };
  const { items, keepWarranty } = buildDrafts(rows, ctx, now);
  for (const item of items) {
    await upsertItem(tenant, item, transaction);
  }
  const expired = await closeExpiredItems(tenant, KIND.PROJECT_WARRANTY, now, transaction);
  const keep = [...items.map((item) => item.sourceId), ...keepWarranty];
  const cancelled = await cancelStaleItems(tenant, STALE_KINDS, keep, STALE_REASON, transaction);
  return { upserted: items.length, warrantyClosed: expired.length, cancelled: cancelled.length };
}

module.exports = { runBackfill, buildDrafts, STALE_REASON };
