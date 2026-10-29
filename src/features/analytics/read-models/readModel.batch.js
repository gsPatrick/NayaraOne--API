'use strict';

/**
 * M9-D607 (3.2 passo 7) — registro por LOTE: o worker acumula, por read model, o que aplicou durante o despacho de uma empresa
 * (uma transação do dispatcher) e, no fim do lote, grava UMA linha em read_model_refreshes (trigger EVENT, rows_upserted do lote) em vez
 * de uma por evento. Os listeners de fim de lote (checks de qualidade da M9-D696) rodam no máximo a cada `analytics.refresh.lote_segundos`
 * por empresa e read model. O acúmulo fica em memória, preso à transação raiz; evento que falha depois de contado só faz o diário
 * subestimar/superestimar uma linha, nunca a projeção (que é transacional).
 */
const clock = require('../metrics/clock');
const { enableAnalyticsWriter } = require('../metricStore.service');
const { startRefresh, finishRefresh } = require('../readModelRefreshStore.service');
const { readRefreshParams } = require('./readModel.settings');
const { getReadModel } = require('./readModel.registry');

const pending = new WeakMap(); // transação raiz -> Map("empresa|modelo" -> acúmulo)
const lastListenerRun = new Map();
const listeners = [];

function rootOf(transaction) {
  let t = transaction;
  while (t && t.parent) t = t.parent;
  return t;
}

/** Listener chamado no fim do lote: ({ companyId, groupId, readModel, rowsUpserted, refreshId }, transaction). */
function onBatchFlushed(fn) {
  listeners.push(fn);
}

function recordUpsert(transaction, { companyId, groupId, readModel, sourceSnapshotAt, lastEventId }) {
  const root = rootOf(transaction);
  const map = pending.get(root) || new Map();
  pending.set(root, map);
  const id = `${companyId}|${readModel}`;
  const entry = map.get(id) || { companyId, groupId, readModel, rows: 0, sourceSnapshotAt: null, lastEventId: null };
  entry.rows += 1;
  if (sourceSnapshotAt && (!entry.sourceSnapshotAt || new Date(sourceSnapshotAt) > new Date(entry.sourceSnapshotAt))) entry.sourceSnapshotAt = sourceSnapshotAt;
  entry.lastEventId = lastEventId || entry.lastEventId;
  map.set(id, entry);
}

async function runListeners(entry, refreshId, params, now, transaction) {
  const id = `${entry.companyId}|${entry.readModel}`;
  const last = lastListenerRun.get(id) || 0;
  if (now.getTime() - last < params.batchSeconds * 1000) return;
  lastListenerRun.set(id, now.getTime());
  for (const fn of listeners) await fn({ ...entry, rowsUpserted: entry.rows, refreshId }, transaction);
}

/** Dispara os listeners de fim de lote (checks de qualidade) respeitando o intervalo mínimo; usado também pelo refresh agendado. */
function notifyBatchListeners(entry, refreshId, params, now, transaction) {
  return runListeners({ ...entry, rows: entry.rows }, refreshId, params, now, transaction);
}

/** Fecha o lote da transação: uma linha de refresh por empresa e read model tocados. Devolve as linhas gravadas. */
async function flushBatch(transaction, { now = clock.now() } = {}) {
  const root = rootOf(transaction);
  const map = pending.get(root);
  if (!map || !map.size) return [];
  pending.delete(root);
  await enableAnalyticsWriter(transaction);
  const written = [];
  for (const entry of map.values()) {
    const def = getReadModel(entry.readModel);
    const ctx = { companyId: entry.companyId, groupId: entry.groupId };
    const row = await startRefresh({ groupId: entry.groupId, companyId: entry.companyId, readModel: entry.readModel, trigger: 'EVENT', version: def ? def.version : 1 }, ctx, transaction);
    const done = await finishRefresh(row.id, { status: 'SUCCEEDED', rowsUpserted: entry.rows, lastSourceEventId: entry.lastEventId, sourceSnapshotAt: entry.sourceSnapshotAt }, ctx, transaction);
    written.push(done);
    await runListeners(entry, done.id, await readRefreshParams(ctx, transaction), now, transaction);
  }
  return written;
}

/** Só para teste. */
function resetBatchState() {
  lastListenerRun.clear();
  listeners.length = 0;
}

module.exports = { recordUpsert, flushBatch, notifyBatchListeners, onBatchFlushed, resetBatchState, rootOf };
