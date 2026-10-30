'use strict';

/**
 * M9-D608 — rebuild completo de read model a partir das fontes, com resultado reproduzível (Caderno §14, Guia §4, §21).
 * `rebuildReadModel(ctx, { model, companyId, reason })`:
 *   0. exige a permissão analytics:rebuild e o parâmetro analytics.rebuild.habilitado da empresa (LIGADO em LAB, DESLIGADO em produção);
 *   1. trava o read model (advisory lock de transação mantida aberta até o fim): segundo pedido recebe 409 ANALYTICS_REBUILD_IN_PROGRESS;
 *   2. abre read_model_refreshes (REBUILD, RUNNING);
 *   3. FASE 1, REPEATABLE READ (fotografia única): cria a tabela sombra, recalcula todos os agregados da fonte, roda os checks de
 *      qualidade sobre a sombra e compara com a atual (linhas, hash e diferença por chave). Check CRITICAL falho aborta (422);
 *      diferença sem motivo aborta (422 ANALYTICS_REBUILD_REASON_REQUIRED);
 *   4. FASE 2, uma transação: troca atômica (rebuild.swap), correções de snapshots (revision_no + 1, recalculated), auditoria,
 *      diário SUCCEEDED e evento analytics.read_model.rebuilt; descarta a sombra.
 * Qualquer falha descarta a sombra, mantém a tabela atual intacta e fecha o diário como FAILED.
 */
const { sequelize } = require('../../../models');
const { Transaction } = require('sequelize');
const logger = require('../../../utils/logger');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { publishDomainEvent } = require('../../../engines/events/outbox');
const clock = require('../metrics/clock');
const { assertPermission } = require('../security/permissionGuard');
const { P } = require('../security/permissionCatalog');
const { enableAnalyticsWriter } = require('../metricStore.service');
const { getReadModel } = require('./readModel.registry');
const { readRebuildParams } = require('./rebuild.settings');
const errors = require('./rebuild.errors');
const { createShadow, dropShadow, fillShadow } = require('./rebuild.shadow');
const { compareWithShadow } = require('./rebuild.compare');
const { runRebuildChecks } = require('./rebuild.checks');
const { swapShadow } = require('./rebuild.swap');
const { applyCorrections } = require('./rebuild.snapshots');
const { openRebuild, closeRebuild } = require('./rebuild.journal');
const { emitRefreshed } = require('./readModel.refreshed');

const EVENT_TYPE = 'analytics.read_model.rebuilt';
const READ_COMMITTED = { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED };
const REPEATABLE_READ = { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ };

/** Transação com o contexto de empresa (RLS) e de quem pediu. */
function tenantTx(scope, actorUserId, options, fn) {
  return sequelize.transaction(options, async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)", {
      replacements: { g: scope.groupId, c: scope.companyId, u: actorUserId || '' }, transaction,
    });
    return fn(transaction);
  });
}

async function resolveModel(model) {
  const def = getReadModel(model);
  if (!def) throw errors.unknownModel(model);
  if (!def.rebuild || typeof def.rebuild.keys !== 'function') throw errors.notSupported(model);
  return def;
}

/** Empresa do grupo de quem pediu? Empresa de outro grupo é 404, nunca 403. */
async function assertCompany(scope, actorUserId) {
  return tenantTx(scope, actorUserId, READ_COMMITTED, async (transaction) => {
    const [rows] = await sequelize.query('SELECT 1 FROM core.companies WHERE id = :c AND group_id = :g', { replacements: { c: scope.companyId, g: scope.groupId }, transaction });
    if (!rows.length) throw errors.companyNotFound();
    return readRebuildParams(scope, transaction);
  });
}

async function phaseOne(def, scope, ctx, refreshId) {
  return tenantTx(scope, ctx.actorUserId, REPEATABLE_READ, async (transaction) => {
    const [[snap]] = await sequelize.query('SELECT pg_current_snapshot()::text AS text, clock_timestamp() AS at', { transaction });
    await enableAnalyticsWriter(transaction);
    await createShadow(def.name, scope.companyId, transaction);
    const filled = await fillShadow(def, scope, { snapshotAt: snap.at, now: clock.now(), asOfDate: clock.businessToday() }, transaction);
    const quality = await runRebuildChecks({ def, scope, refreshId }, transaction);
    const diff = await compareWithShadow(def, scope.companyId, transaction);
    return { snapshotText: snap.text, snapshotAt: snap.at, rows: filled.rows, quality, diff };
  });
}

function eventPayload(def, scope, refreshId, built, swap, snapshots, reason) {
  return {
    readModel: def.name, readModelVersion: def.version, companyId: scope.companyId, refreshId,
    rowsBefore: built.diff.before.rows, rowsAfter: built.diff.after.rows, hashBefore: built.diff.before.hash, hashAfter: built.diff.after.hash,
    added: built.diff.added, removed: built.diff.removed, changed: built.diff.changed, reapplied: swap.reapplied, snapshotsRevised: snapshots.revised,
    reason: reason || null,
  };
}

async function phaseTwo(def, scope, ctx, refreshId, built, params) {
  return tenantTx(scope, ctx.actorUserId, READ_COMMITTED, async (transaction) => {
    await enableAnalyticsWriter(transaction);
    const swap = await swapShadow(def, scope, {
      snapshotText: built.snapshotText, snapshotAt: built.snapshotAt, windowMinutes: params.reapplyWindowMinutes, asOfDate: clock.businessToday(), now: clock.now(),
    }, transaction);
    const snapshots = await applyCorrections(def, scope, built.snapshotAt, transaction);
    await dropShadow(def.name, scope.companyId, transaction);
    const diff = { ...built.diff, reapplied: swap.reapplied, snapshotsRevised: snapshots.revised };
    const done = await closeRebuild(refreshId, scope, { status: 'SUCCEEDED', rowsUpserted: built.rows, sourceSnapshotAt: built.snapshotAt }, diff, transaction);
    await registrarAuditoria({
      groupId: scope.groupId, companyId: scope.companyId, actorUserId: ctx.actorUserId, action: EVENT_TYPE, entityType: 'analytics.read_model', entityId: refreshId,
      beforeJson: built.diff.before, afterJson: { ...built.diff.after, added: built.diff.added, removed: built.diff.removed, changed: built.diff.changed },
      reason: ctx.reason || 'Reconstrução do read model a partir das fontes.',
    }, transaction);
    await publishDomainEvent({
      groupId: scope.groupId, companyId: scope.companyId, aggregateType: 'ReadModel', aggregateId: refreshId, eventType: EVENT_TYPE, eventVersion: 1, classification: 'INTERNAL',
      payload: { ...eventPayload(def, scope, refreshId, built, swap, snapshots, ctx.reason), durationMs: done ? done.duration_ms : null },
      idempotencyKey: `${EVENT_TYPE}:${refreshId}`,
    }, transaction);
    emitRefreshed(transaction, { readModel: def.name, companyId: scope.companyId, groupId: scope.groupId, refreshId }); // o cache dos painéis descarta a empresa (M9-D698)
    return { swap, snapshots, durationMs: done ? done.duration_ms : null };
  });
}

/** Falha: descarta a sombra e fecha o diário como FAILED (cada passo em transação própria; falha de limpeza só vai para o log). */
async function abandon(def, scope, ctx, refreshId, error, diff) {
  try {
    await tenantTx(scope, ctx.actorUserId, READ_COMMITTED, (transaction) => dropShadow(def.name, scope.companyId, transaction));
  } catch (err) {
    logger.error({ event: 'analytics.read_model.rebuild_cleanup_failed', readModel: def.name, err }, '[analytics] não foi possível descartar a tabela sombra');
  }
  if (!refreshId) return;
  try {
    await tenantTx(scope, ctx.actorUserId, READ_COMMITTED, (transaction) => closeRebuild(
      refreshId, scope, { status: 'FAILED', errorCode: String((error && error.code) || 'ANALYTICS_REBUILD_FAILED').slice(0, 80), errorMessage: error && error.message }, diff, transaction
    ));
  } catch (err) {
    logger.error({ event: 'analytics.read_model.rebuild_journal_failed', readModel: def.name, err }, '[analytics] não foi possível fechar o diário do rebuild');
  }
}

async function runLocked(def, scope, ctx, params, hooks) {
  let refreshId = null;
  let diff = null;
  try {
    const opened = await tenantTx(scope, ctx.actorUserId, READ_COMMITTED, (transaction) => openRebuild(def, scope, ctx.reason, transaction));
    refreshId = opened.id;
    const built = await phaseOne(def, scope, ctx, refreshId);
    diff = built.diff;
    if (built.quality.blocked) throw errors.qualityFailed(built.quality.checks.map((c) => ({ checkCode: c.check_code, status: c.status, severity: c.severity })));
    if (built.diff.different && !ctx.reason) throw errors.reasonRequired(built.diff);
    if (hooks.afterShadow) await hooks.afterShadow({ refreshId, shadowRows: built.rows, diff: built.diff });
    const done = await phaseTwo(def, scope, ctx, refreshId, built, params);
    return {
      refreshId, readModel: def.name, companyId: scope.companyId, status: 'SUCCEEDED', rows: built.rows,
      before: built.diff.before, after: built.diff.after, added: built.diff.added, removed: built.diff.removed, changed: built.diff.changed,
      reapplied: done.swap.reapplied, snapshotsRevised: done.snapshots.revised, durationMs: done.durationMs,
    };
  } catch (err) {
    await abandon(def, scope, ctx, refreshId, err, diff);
    throw err;
  }
}

/**
 * Reconstrói o read model de UMA empresa. ctx: { groupId, actorUserId, permissions, reason }. `hooks.afterShadow` é só para teste
 * (roda com a sombra pronta e antes da troca, quando o worker ainda pode aplicar eventos). Devolve o resumo com hash antes e depois.
 */
async function rebuildReadModel(ctx, { model, companyId, hooks = {} }) {
  assertPermission(ctx, P.REBUILD);
  const def = await resolveModel(model);
  const scope = { groupId: ctx.groupId, companyId };
  const params = await assertCompany(scope, ctx.actorUserId);
  if (!params.enabled) throw errors.disabled();
  return sequelize.transaction(READ_COMMITTED, async (lockTx) => {
    const [[lock]] = await sequelize.query('SELECT pg_try_advisory_xact_lock(hashtextextended(:key, 0)) AS ok', { replacements: { key: `analytics.rebuild|${def.name}|${scope.companyId}` }, transaction: lockTx });
    if (!lock.ok) throw errors.inProgress(); // um rebuild por empresa e read model de cada vez (a sombra é uma por empresa e modelo)
    return runLocked(def, scope, ctx, params, hooks);
  });
}

module.exports = { rebuildReadModel, EVENT_TYPE };
