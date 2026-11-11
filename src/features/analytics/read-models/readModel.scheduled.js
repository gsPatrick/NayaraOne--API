'use strict';

/**
 * M9-D607 (3.3) — refresh por agenda de UMA empresa: para cada read model registrado com `scheduled` (depende de relógio) e para os
 * agregados adiados por passar do teto de linhas (rm_stale_aggregates), recalcula o ESTADO da fonte agora (sem teto de linhas: esta
 * é a janela que o evento empurrou o trabalho pesado para), grava com source_snapshot_at/refreshed_at e registra UMA linha em
 * read_model_refreshes (trigger SCHEDULE) por read model. Falha de um read model fica registrada como FAILED e não impede os demais.
 */
const { sequelize } = require('../../../models');
const logger = require('../../../utils/logger');
const { businessDateKey } = require('../../../utils/businessDate');
const clock = require('../metrics/clock');
const { enableAnalyticsWriter } = require('../metricStore.service');
const { startRefresh, finishRefresh } = require('../readModelRefreshStore.service');
const { listReadModels } = require('./readModel.registry');
const { lockAggregate, upsertAggregate, clearStale, listStale, keyText } = require('./readModel.upsert');
const { notifyBatchListeners } = require('./readModel.batch');
const { withOltpGuards } = require('./readModel.protect');
const { emitRefreshed } = require('./readModel.refreshed');

async function keysOf(def, scope, params, now, transaction) {
  const scheduled = def.scheduled ? await def.scheduled.keys({ ...scope, limit: params.batchRows, now, transaction }) : [];
  const stale = await listStale(def, scope.companyId, params.batchRows, transaction);
  const seen = new Map();
  for (const key of [...scheduled, ...stale]) seen.set(keyText(def, key), key);
  return [...seen.values()];
}

async function refreshModel(def, scope, params, now, transaction) {
  const keys = await keysOf(def, scope, params, now, transaction);
  if (!keys.length) return null;
  const ctx = { companyId: scope.companyId, groupId: scope.groupId };
  const row = await startRefresh({ ...ctx, readModel: def.name, trigger: 'SCHEDULE', version: def.version }, ctx, transaction);
  let rows = 0;
  let lastSnapshot = null;
  try {
    await sequelize.transaction({ transaction }, (savepoint) => withOltpGuards(savepoint, params, async () => { // statement_timeout e lock_timeout (M9-D698 3.4)
      for (const key of keys) {
        await lockAggregate(def, scope.companyId, key, savepoint);
        const result = await def.recompute({ ...scope, key, limit: null, asOfDate: businessDateKey(now), now, event: null, transaction: savepoint });
        const snapshotAt = result.sourceSnapshotAt || now;
        await upsertAggregate(def, { ...scope, key, fields: result.fields, rows: result.rows, sourceSnapshotAt: snapshotAt }, savepoint);
        await clearStale(def, { ...scope, key }, savepoint);
        rows += 1;
        lastSnapshot = snapshotAt;
      }
    }));
  } catch (err) {
    logger.error({ event: 'analytics.read_model.scheduled_failed', readModel: def.name, companyId: scope.companyId, err }, '[analytics] refresh agendado falhou');
    await finishRefresh(row.id, { status: 'FAILED', errorCode: String(err.code || 'READ_MODEL_REFRESH_FAILED').slice(0, 80), errorMessage: err.message }, ctx, transaction);
    return { readModel: def.name, failed: true };
  }
  const done = await finishRefresh(row.id, { status: 'SUCCEEDED', rowsUpserted: rows, sourceSnapshotAt: lastSnapshot }, ctx, transaction);
  emitRefreshed(transaction, { readModel: def.name, companyId: scope.companyId, groupId: scope.groupId, refreshId: done.id });
  await notifyBatchListeners({ ...ctx, readModel: def.name, rows, sourceSnapshotAt: lastSnapshot, lastEventId: null }, done.id, params, now, transaction);
  return { readModel: def.name, rows, refreshId: done.id };
}

/**
 * Passada agendada da empresa (já com o contexto de tenant na transação). Devolve o resumo por read model. DI-BI-3: `cadence` restringe aos read models que têm agenda
 * própria (`ownCadence`, ex.: 'tech', recalculados pelo job deles) e `skipOwnCadence` os deixa de fora (a agenda geral não disputa a trava do agregado com o job próprio).
 */
async function refreshCompanyScheduled(scope, params, transaction, { now = clock.now(), cadence = null, skipOwnCadence = false } = {}) {
  await enableAnalyticsWriter(transaction);
  const out = [];
  const selected = listReadModels().filter((def) => (cadence ? def.ownCadence === cadence : !(skipOwnCadence && def.ownCadence)));
  for (const def of selected) {
    const r = await refreshModel(def, scope, params, now, transaction);
    if (r) out.push(r);
  }
  return out;
}

module.exports = { refreshCompanyScheduled };
