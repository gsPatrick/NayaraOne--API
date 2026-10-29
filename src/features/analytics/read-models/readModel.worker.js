'use strict';

/**
 * M9-D607 (3.2) — worker de read models: aplica UM evento do outbox às projeções registradas para o tipo dele.
 * Por read model, no mesmo savepoint do chamador: (1) registra o evento em rm_applied_events (PK; repetido = ignorado, nada muda);
 * (2) trava o agregado; (3) recalcula o ESTADO a partir da fonte, restrito à linha do agregado e ao teto de linhas; (4) UPSERT com
 * source_snapshot_at = max(...), refreshed_at e version. Falha em qualquer passo desfaz tudo, inclusive o registro do evento.
 * Evento desconhecido ou de empresa que não existe mais é ignorado com log, sem derrubar o worker.
 * M9-D698 (3.4): o passo todo roda com statement_timeout e lock_timeout locais (readModel.protect).
 */
const { sequelize } = require('../../../models');
const logger = require('../../../utils/logger');
const { businessDateKey } = require('../../../utils/businessDate');
const clock = require('../metrics/clock');
const { enableAnalyticsWriter } = require('../metricStore.service');
const { modelsFor } = require('./readModel.registry');
const { lockAggregate, upsertAggregate, markStale, clearStale, keyText } = require('./readModel.upsert');
const { readRefreshParams } = require('./readModel.settings');
const { recordUpsert } = require('./readModel.batch');
const { withOltpGuards } = require('./readModel.protect');
const { replayIgnored, staleDeferred } = require('./readModel.metrics');

async function applyToModel(def, event, scope, params, transaction, now) {
  const key = await def.aggregateKey(event, { now, transaction }); // pode ser async (resolve a obra pelo registro do evento)
  if (!key) return { skipped: 1 };
  const [claimed] = await sequelize.query(
    `INSERT INTO analytics.rm_applied_events (read_model, source_event_id, company_id, group_id, aggregate_id, aggregate_key)
     VALUES (:model, :eventId, :companyId, :groupId, :aggregateId, :aggregateKey) ON CONFLICT DO NOTHING RETURNING source_event_id`,
    { replacements: { model: def.name, eventId: String(event.id), companyId: scope.companyId, groupId: scope.groupId, aggregateId: String(event.aggregateId || keyText(def, key)), aggregateKey: keyText(def, key) }, transaction }
  );
  if (!claimed.length) {
    replayIgnored.inc({ read_model: def.name });
    logger.info({ event: 'analytics.read_model.replay_ignored', readModel: def.name, sourceEventId: event.id, replay_ignored: 1 }, '[analytics] evento já aplicado, ignorado');
    return { replayIgnored: 1 };
  }
  await lockAggregate(def, scope.companyId, key, transaction);
  const result = await def.recompute({ ...scope, key, limit: params.maxAggregateRows, asOfDate: businessDateKey(now), now, event, transaction });
  if (result && result.truncated) {
    await markStale(def, { ...scope, key }, transaction);
    staleDeferred.inc({ read_model: def.name });
    return { stale: 1 };
  }
  const snapshotAt = result.sourceSnapshotAt || event.occurredAt || now;
  await upsertAggregate(def, { ...scope, key, fields: result.fields, rows: result.rows, sourceSnapshotAt: snapshotAt }, transaction);
  await clearStale(def, { ...scope, key }, transaction);
  return { upserted: 1, def, snapshotAt };
}

async function companyExists(companyId, transaction) {
  const [rows] = await sequelize.query('SELECT 1 FROM core.companies WHERE id = :id', { replacements: { id: companyId }, transaction });
  return rows.length > 0;
}

/** Aplica o evento (instância do outbox ou objeto com os mesmos campos). Devolve o resumo; erro propaga para o retry do outbox. */
async function applyEvent(event, transaction, options = {}) {
  const defs = modelsFor(event.eventType);
  if (!defs.length) {
    logger.warn({ event: 'analytics.read_model.unknown_event', eventType: event.eventType }, '[analytics] evento sem read model, ignorado');
    return { ignored: 'UNKNOWN_EVENT' };
  }
  const scope = { companyId: event.companyId, groupId: event.groupId };
  const now = options.now || clock.now();
  const out = { upserted: 0, replayIgnored: 0, stale: 0, skipped: 0 };
  const upserts = await sequelize.transaction({ transaction }, async (savepoint) => {
    await enableAnalyticsWriter(savepoint);
    if (!(await companyExists(scope.companyId, savepoint))) {
      logger.warn({ event: 'analytics.read_model.orphan_event', companyId: scope.companyId, sourceEventId: event.id }, '[analytics] evento de empresa inexistente, ignorado');
      return null;
    }
    const params = options.params || await readRefreshParams(scope, savepoint);
    const done = [];
    await withOltpGuards(savepoint, params, async () => { // statement_timeout e lock_timeout (M9-D698 3.4)
      for (const def of defs) {
        const r = await applyToModel(def, event, scope, { ...params, ...(options.maxAggregateRows ? { maxAggregateRows: options.maxAggregateRows } : {}) }, savepoint, now);
        for (const k of ['upserted', 'replayIgnored', 'stale', 'skipped']) out[k] += r[k] || 0;
        if (r.upserted) done.push(r);
      }
    });
    return done;
  });
  if (upserts === null) return { ignored: 'ORPHAN_COMPANY' };
  for (const r of upserts) recordUpsert(transaction, { ...scope, readModel: r.def.name, sourceSnapshotAt: r.snapshotAt, lastEventId: String(event.id) });
  return out;
}

module.exports = { applyEvent };
