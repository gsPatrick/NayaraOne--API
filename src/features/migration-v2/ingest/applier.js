'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { MODES, BATCH } = require('./ingest.constants');
const { isCdcToken, compareCdc, compareWatermark } = require('./tokens');
const errors = require('./ingest.errors');
const sources = require('./source.repository');
const batches = require('./batch.repository');
const records = require('./record.repository');
const { applyEvent } = require('./applier.event');
const { batchRoot } = require('./batch.hash');
const { loadSchema } = require('../integrity/schema.repository');
const { replaceLeaves } = require('../integrity/leaves.repository');
const { getTarget } = require('./targets');
const { sha256 } = require('./row.canonical');

const IDEM_MAX = 255;
/** Chave de idempotência do evento: `<sistema>:<entidade>:<chave>:<posição>`; passando do limite da coluna vira o SHA-256 do texto. */
function idempotencyKey(source, event) {
  const text = `${source.source_system}:${source.entity}:${event.sourceKey}:${event.position}`;
  return text.length > IDEM_MAX ? `h:${sha256(text)}` : text;
}

/** O token `candidate` passa do `current` no modo da fonte? (FULL_DIFF não tem checkpoint.) */
function advances(mode, current, candidate) {
  if (!candidate || mode === MODES.FULL_DIFF) return false;
  if (!current) return true;
  return mode === MODES.CDC ? compareCdc(candidate, current) > 0 : compareWatermark(candidate, current) > 0;
}

/**
 * Posição fora de ordem (M9-D900 §4): o lote CDC não pode começar depois do último checkpoint (haveria eventos faltando). Começar antes (ou no checkpoint) é replay ou
 * continuação normal. Fonte sem checkpoint só aceita começar do início (token nulo ou 0).
 */
function assertNoGap(source, fromToken) {
  if (source.mode !== MODES.CDC || !fromToken) return;
  if (!isCdcToken(fromToken)) throw errors.positionGap({ fromToken });
  const checkpoint = source.checkpoint_token || '0';
  if (compareCdc(fromToken, checkpoint) > 0) throw errors.positionGap({ fromToken, checkpoint });
}

/**
 * Aplica os eventos do lote numa transação (a do chamador), M9-D900 §3.2 a §3.5: trava a fonte, descarta o evento cuja chave de idempotência
 * (`<sistema>:<entidade>:<chave>:<posição>`) já foi aplicada, aplica o resto em ordem de posição, avança o checkpoint para `batch.to_token` e leva o lote de RUNNING a APPLIED
 * com o resumo e a auditoria `migration.batch.applied`. Replay (`batch.replay_of`) nunca move o checkpoint. Qualquer erro desfaz tudo (o chamador faz o rollback).
 */
async function applyBatch(tenant, actor, batch, events, transaction) {
  const source = await sources.lock(tenant, batch.source_id, transaction);
  if (!source) throw errors.runInvalid('Fonte não encontrada.');
  if (!batch.replay_of) assertNoGap(source, batch.from_token);
  const idemOf = (event) => idempotencyKey(source, event);
  const keys = [...new Set(events.map((event) => event.sourceKey))];
  const known = await records.loadByKeys(tenant, source, keys, transaction);
  const applied = await records.loadAppliedKeys(tenant, events.map(idemOf), transaction);
  const ctx = { tenant, actor, batch, transaction };
  const counts = { events: events.length, skipped: 0, migrated: 0, unchanged: 0, deleted: 0, quarantined: 0, review: 0, kept: 0, ignored: 0 };
  for (const event of events) {
    const idem = idemOf(event);
    if (applied.has(idem)) { counts.skipped += 1; continue; }
    const { outcome, record } = await applyEvent(ctx, source, event, known.get(event.sourceKey));
    known.set(event.sourceKey, record);
    counts[outcome] += 1;
    await records.insertEventKey(tenant, idem, batch.id, transaction);
    applied.add(idem);
  }
  if (!batch.replay_of && advances(source.mode, source.checkpoint_token, batch.to_token)) await sources.setCheckpoint(tenant, source.id, batch.to_token, transaction);
  // lado da origem da verificação (M9-D905): raiz Merkle do que foi lido e as folhas guardadas para apontar divergência
  const side = batchRoot(await loadSchema(tenant, source.entity, transaction), getTarget(source.entity), keys.map((key) => known.get(key)).filter(Boolean));
  await replaceLeaves(tenant, batch.id, side.leaves, transaction);
  const rootHash = side.root;
  const done = await batches.transition(tenant, batch.id, BATCH.APPLIED, { rowCount: events.length, rootHash, sourceRoot: rootHash, sourceCount: side.count }, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor && actor.userId, action: 'migration.batch.applied', entityType: 'MigBatch', entityId: batch.id,
    afterJson: { runId: batch.run_id, source: source.source_system, entity: source.entity, fromToken: batch.from_token, toToken: batch.to_token, rowCount: events.length, rootHash, replayOf: batch.replay_of, counts },
    reason: `Lote ${batch.replay_of ? 'de replay ' : ''}da migração aplicado (${events.length} eventos).`,
  }, transaction);
  return { batch: done, counts };
}

module.exports = { applyBatch, assertNoGap, advances, idempotencyKey };
