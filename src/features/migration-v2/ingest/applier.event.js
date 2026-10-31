'use strict';

const { RECORD, OPS } = require('./ingest.constants');
const { mapRow, rowHash } = require('./row.canonical');
const records = require('./record.repository');
const { getTarget } = require('./targets');
const externalRefs = require('../externalRefs.service');
const { normalizeTemporal } = require('../timezone/timezone.normalize');
const { temporalContext } = require('../timezone/timezone.context');

const MIGRATED_STATES = [RECORD.MIGRATED, RECORD.RECONCILED];
const KEPT_STATES = [RECORD.QUARANTINED, RECORD.PENDING_REVIEW];

/** Grava o resultado de uma linha no destino e a referência do ID legado (M9-D906) na MESMA transação; devolve o id do destino. */
async function writeTarget(ctx, source, sourceKey, row, existing) {
  const target = getTarget(source.entity);
  const targetId = await target.upsert(ctx.tenant, ctx.actor, row, existing && existing.target_entity_id, ctx.transaction);
  await externalRefs.register(ctx.tenant, ctx.actor, {
    entityType: source.entity, entityId: targetId, sourceSystem: source.source_system, sourceKey, migrationRunId: ctx.batch.run_id,
  }, ctx.transaction);
  return targetId;
}

/** Evento D: exclusão lógica. O destino fica com source_deleted; chave desconhecida vira registro EXCLUDED (nada a apagar). */
async function applyDelete(ctx, source, event, existing) {
  if (existing && existing.target_entity_id) await getTarget(source.entity).markDeleted(ctx.tenant, existing.target_entity_id, ctx.transaction);
  const saved = await records.upsert(ctx.tenant, source, event.sourceKey, existing
    ? { ...camel(existing), sourceDeleted: true, batchId: ctx.batch.id, position: event.position }
    : { state: RECORD.EXCLUDED, reason: 'Excluído na origem antes de ser migrado.', sourceDeleted: true, batchId: ctx.batch.id, position: event.position }, ctx.transaction);
  return { outcome: 'deleted', record: saved };
}

const camel = (row) => ({
  state: row.state, reason: row.reason, sourceVersion: row.source_version, payload: row.source_payload, rowHash: row.row_hash, targetEntityId: row.target_entity_id,
  batchId: row.batch_id, position: row.last_position, sourceDeleted: row.source_deleted,
});

/** Eventos I e U: upsert pela chave externa, com as regras de delta da M9-D901 §3.1 (EXCLUDED ignora; QUARANTINED/PENDING_REVIEW só atualizam o conteúdo de origem). */
async function applyUpsert(ctx, source, event, existing) {
  const mapped = event.canonical ? event.record : mapRow(event.record, source.config && source.config.columnMap); // `canonical`: registro PENDING relido do banco (já mapeado)
  const temporal = await temporalContext(ctx, source.entity); // M9-D908 §3.2: data sem hora fica no dia civil; data e hora sem fuso vai a UTC pelo fuso de origem
  const { row, verdict: temporalVerdict } = normalizeTemporal(mapped, temporal.schema, temporal.options);
  const hash = rowHash(row);
  const base = { payload: row, rowHash: hash, batchId: ctx.batch.id, position: event.position, sourceDeleted: false };
  if (existing && existing.state === RECORD.EXCLUDED) return { outcome: 'ignored', record: existing };
  if (existing && KEPT_STATES.includes(existing.state)) {
    const reason = existing.state === RECORD.PENDING_REVIEW ? `Mudou na origem. ${existing.reason || ''}`.trim() : existing.reason;
    const saved = await records.upsert(ctx.tenant, source, event.sourceKey, { ...camel(existing), ...base, state: existing.state, reason, sourceVersion: existing.source_version + 1 }, ctx.transaction);
    return { outcome: 'kept', record: saved };
  }
  if (existing && MIGRATED_STATES.includes(existing.state) && existing.row_hash === hash && !existing.source_deleted) {
    const saved = await records.upsert(ctx.tenant, source, event.sourceKey, { ...camel(existing), position: event.position }, ctx.transaction);
    return { outcome: 'unchanged', record: saved };
  }
  const verdict = temporalVerdict || await getTarget(source.entity).assess(ctx.tenant, row, existing && existing.target_entity_id, ctx.transaction);
  const version = existing ? existing.source_version + (existing.row_hash === hash ? 0 : 1) : 1;
  if (verdict) {
    const saved = await records.upsert(ctx.tenant, source, event.sourceKey, { ...base, state: verdict.state, reason: verdict.reason, sourceVersion: version, targetEntityId: existing && existing.target_entity_id }, ctx.transaction);
    return { outcome: verdict.state === RECORD.QUARANTINED ? 'quarantined' : 'review', record: saved };
  }
  const targetId = await writeTarget(ctx, source, event.sourceKey, row, existing);
  const saved = await records.upsert(ctx.tenant, source, event.sourceKey, { ...base, state: RECORD.MIGRATED, reason: null, sourceVersion: version, targetEntityId: targetId }, ctx.transaction);
  return { outcome: 'migrated', record: saved };
}

/** Aplica UM evento já descartado de repetição. */
function applyEvent(ctx, source, event, existing) {
  return event.op === OPS.DELETE ? applyDelete(ctx, source, event, existing) : applyUpsert(ctx, source, event, existing);
}

module.exports = { applyEvent, applyUpsert, writeTarget };
