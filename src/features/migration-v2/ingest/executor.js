'use strict';

const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const logger = require('../../../utils/logger');
const { MODES, RUN } = require('./ingest.constants');
const connectors = require('./connectors');
const cdc = require('./cdc.reader');
const watermark = require('./watermark.reader');
const fulldiff = require('./fulldiff.reader');
const sources = require('./source.repository');
const batches = require('./batch.repository');
const runs = require('./run.repository');
const { runBatch, loadSettings } = require('./batch.runner');
const { processPending } = require('./pending.processor');
const { loadSchema } = require('../integrity/schema.repository');
const { markMissingKeys } = require('./deletions');
const { ensureSeeded } = require('../seeds/sources.seed');
const { assertMode } = require('./modes');

const COUNT_KEYS = ['events', 'skipped', 'migrated', 'unchanged', 'deleted', 'quarantined', 'review', 'kept', 'ignored'];
const emptyTotals = () => Object.fromEntries(COUNT_KEYS.map((key) => [key, 0]));

/** Executa a leitura de UMA fonte até esgotá-la, um lote por vez (M9-D900 §3). Devolve o resumo da fonte; erro vira `error` e interrompe só esta fonte. */
async function runSource(tenant, actor, run, sourceRow, settings) {
  const summary = { source: sourceRow.source_system, entity: sourceRow.entity, mode: sourceRow.mode, batches: 0, deletedBySource: 0, totals: emptyTotals(), error: null };
  let connector = null;
  try {
    const source = await openTenantTx(tenant, (transaction) => sources.get(tenant, sourceRow.id, transaction));
    assertMode(source.mode);
    await openTenantTx(tenant, (transaction) => loadSchema(tenant, source.entity, transaction)); // sem esquema canônico não se abre lote (M9-D905: 422 GOV_MIG_SCHEMA_MISSING)
    const add = (res) => { summary.batches += 1; for (const key of COUNT_KEYS) summary.totals[key] += res.counts[key] || 0; };
    for (const res of (await processPending(tenant, actor, run.id, source, settings)).results) add(res); // PENDING devolvido pela decisão REPROCESS (M9-D901)
    connector = await connectors.open(source);
    let cursor = source.mode === MODES.WATERMARK ? watermark.startCursor(source.checkpoint_token, settings.overlapSeconds) : (source.mode === MODES.CDC ? source.checkpoint_token : null);
    for (;;) {
      let plan;
      if (source.mode === MODES.CDC) plan = await cdc.plan(connector, { cursor, limit: settings.batchSize });
      else if (source.mode === MODES.WATERMARK) plan = await watermark.plan(connector, { cursor, limit: settings.batchSize });
      else plan = await fulldiff.plan(connector, source, { cursor, limit: settings.batchSize });
      if (!plan) break;
       
      add(await runBatch(tenant, actor, run.id, source, plan, { settings }));
      cursor = plan.toToken;
    }
    if (source.mode === MODES.FULL_DIFF || (source.mode === MODES.WATERMARK && run.last_delta)) summary.deletedBySource = await markMissingKeys(tenant, actor, run.id, source, connector, settings);
  } catch (err) {
    summary.error = { code: err.code || 'ERROR', message: String(err.message || err).slice(0, 500) };
    logger.error({ runId: run.id, source: sourceRow.source_system, err: summary.error }, 'migration.source.failed');
  } finally {
    if (connector) await connector.close().catch(() => {});
  }
  return summary;
}

/**
 * Executa uma execução QUEUED (POST /migration/runs): reivindica a execução (QUEUED -> RUNNING, uma só vence), percorre as fontes escolhidas e fecha com SUCCEEDED ou FAILED
 * (alguma fonte parou por erro ou lote abortado). Devolve o resumo, ou null se outra instância já a reivindicou.
 */
async function executeRun(tenant, runId) {
  const claimed = await openTenantTx(tenant, (transaction) => runs.claim(tenant, runId, transaction));
  if (!claimed) return null;
  const actor = { userId: claimed.requested_by || null };
  const summary = { runId, sources: [] };
  let failure = null;
  try {
    const settings = await loadSettings(tenant);
    const list = await openTenantTx(tenant, async (transaction) => {
      await ensureSeeded(tenant, transaction);
      return sources.list(tenant, { sourceSystem: claimed.source_system, entity: claimed.entity }, transaction);
    });
    for (const source of list) {
       
      summary.sources.push(await runSource(tenant, actor, claimed, source, settings));
    }
  } catch (err) {
    failure = String(err.message || err).slice(0, 500);
  }
  const failed = Boolean(failure) || summary.sources.some((item) => item.error);
  await openTenantTx(tenant, async (transaction) => {
    await runs.finish(tenant, runId, failed ? RUN.FAILED : RUN.SUCCEEDED, summary, failure, transaction);
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId, action: 'migration.run.finished', entityType: 'MigRun', entityId: runId,
      afterJson: { status: failed ? RUN.FAILED : RUN.SUCCEEDED, sources: summary.sources }, reason: 'Execução da migração encerrada.',
    }, transaction);
  });
  return { ...summary, status: failed ? RUN.FAILED : RUN.SUCCEEDED };
}

/** Relatório dos lotes da execução (com o resumo de cada um), na ordem em que foram criados. */
function report(tenant, runId, transaction) {
  return batches.listByRun(tenant, runId, transaction);
}

module.exports = { executeRun, runSource, report };
