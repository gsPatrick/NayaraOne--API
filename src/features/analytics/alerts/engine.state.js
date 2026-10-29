'use strict';

/**
 * M9-D691 (3.1 passos 5 e 6, 3.4) — a máquina de estados do alert engine para UM problema (um fingerprint). Recebe se a condição é verdadeira e
 * o snapshot avaliado e devolve o que fez:
 *  condição verdadeira: instância ativa (OPEN/ACKNOWLEDGED) -> conta a ocorrência, sem nova notificação (REPEATED); resolvida com cooldown ativo ->
 *    não cria e conta a supressão (SUPPRESSED); senão abre OPEN (OPENED) e avisa o owner pelo evento;
 *  condição falsa: instância ativa -> conta avaliação normal e, ao atingir a política (padrão 2), resolve (RESOLVED) e inicia o cooldown; uma
 *    avaliação anormal zera a contagem.
 * Idempotente por snapshot: o mesmo snapshot avaliado de novo (`last_snapshot_id`) não muda estado nem contagem (UNCHANGED).
 */
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const instances = require('./engine.instances');
const { emitAlertEvent, TYPES } = require('./events');

const addMinutes = (date, minutes) => new Date(new Date(date).getTime() + minutes * 60000);

/** Cooldown em minutos: o da definição quando preenchido (0 = sem silêncio); senão o da severidade (parâmetro). */
function cooldownMinutesOf(def, params) {
  return Number.isInteger(def.cooldown_minutes) ? def.cooldown_minutes : params.cooldowns[def.severity];
}

/** Avaliações normais seguidas para resolver: a política da definição prevalece sobre o parâmetro da empresa. */
function evaluationsToResolve(def, params) {
  const own = def.auto_resolve_policy && def.auto_resolve_policy.consecutiveOkEvaluations;
  return Number.isInteger(own) && own >= 1 ? own : params.toResolve;
}

function eventBase(def, row, scope) {
  return {
    instanceId: row.id, alertDefinitionId: def.id, alertCode: def.alert_code, metricCode: row.metric_code, severity: row.severity, companyId: scope.companyId, groupId: scope.groupId,
    ownerUserId: def.owner_user_id || null, ownerRole: def.owner_role || null, createTask: def.create_task === true, fingerprint: row.fingerprint,
  };
}

async function repeat(active, input, transaction) {
  if (active.last_snapshot_id && active.last_snapshot_id === input.snapshotId) return { action: 'UNCHANGED', instance: active };
  return { action: 'REPEATED', instance: await instances.touchRepeated(active.id, input, transaction) };
}

async function open(ctx, input, transaction) {
  const { def, scope, fingerprint, metricCode } = ctx;
  try {
    const row = await sequelize.transaction({ transaction }, (savepoint) => instances.insertOpen({ def, scope, fingerprint, metricCode, ...input }, savepoint));
    emitAlertEvent(transaction, { type: TYPES.OPENED, ...eventBase(def, row, scope), openedAt: row.opened_at });
    return { action: 'OPENED', instance: row };
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'ANALYTICS_ALERT_INSTANCE_ACTIVE') throw err;
    const active = await instances.findActive({ companyId: scope.companyId, fingerprint }, transaction); // outro avaliador abriu primeiro: ramo da instância existente
    if (!active) throw err;
    return repeat(active, input, transaction);
  }
}

async function onTrue(ctx, input, transaction) {
  const { scope, fingerprint } = ctx;
  const key = { companyId: scope.companyId, fingerprint };
  const active = await instances.findActive(key, transaction);
  if (active) return repeat(active, input, transaction);
  const resolved = await instances.findLastResolved(key, transaction);
  if (resolved && resolved.cooldown_until && new Date(resolved.cooldown_until) > new Date(input.now)) {
    if (resolved.last_snapshot_id && resolved.last_snapshot_id === input.snapshotId) return { action: 'UNCHANGED', instance: resolved };
    return { action: 'SUPPRESSED', instance: await instances.suppress(resolved.id, input.snapshotId, transaction) };
  }
  return open(ctx, input, transaction);
}

async function onFalse(ctx, input, transaction) {
  const { def, scope, fingerprint, params } = ctx;
  const active = await instances.findActive({ companyId: scope.companyId, fingerprint }, transaction);
  if (!active) return { action: 'NORMAL', instance: null };
  if (active.last_snapshot_id && active.last_snapshot_id === input.snapshotId) return { action: 'UNCHANGED', instance: active };
  if (active.normal_streak + 1 < evaluationsToResolve(def, params)) return { action: 'NORMALIZING', instance: await instances.touchNormal(active.id, input, transaction) };
  const cooldownUntil = addMinutes(input.now, cooldownMinutesOf(def, params));
  const row = await instances.resolveInstance(active.id, { reason: 'CONDITION_NORMALIZED', now: input.now, cooldownUntil, value: input.value, snapshotId: input.snapshotId }, transaction);
  emitAlertEvent(transaction, { type: TYPES.RESOLVED, ...eventBase(def, row, scope), resolvedAt: row.resolved_at, reason: row.resolved_reason });
  return { action: 'RESOLVED', instance: row };
}

/**
 * ctx = { def, scope, params, fingerprint, metricCode }; input = { conditionTrue, value, snapshotId, now }.
 * Devolve { action, instance }.
 */
function applyEvaluation(ctx, input, transaction) {
  const data = { value: input.value, snapshotId: input.snapshotId, now: input.now };
  return input.conditionTrue ? onTrue(ctx, data, transaction) : onFalse(ctx, data, transaction);
}

/** Encerra as instâncias ativas da definição cujo fingerprint não é mais o dela (o limiar ou a regra mudou). Sem cooldown. */
async function closeChangedInstances(def, scope, currentFingerprint, now, transaction) {
  const closed = [];
  for (const row of await instances.listActiveOf(def.id, transaction)) {
    if (row.fingerprint === currentFingerprint) continue;
    const done = await instances.resolveInstance(row.id, { reason: 'DEFINITION_CHANGED', now }, transaction);
    emitAlertEvent(transaction, { type: TYPES.RESOLVED, ...eventBase(def, done, scope), resolvedAt: done.resolved_at, reason: done.resolved_reason });
    closed.push(done);
  }
  return closed;
}

module.exports = { applyEvaluation, closeChangedInstances, cooldownMinutesOf, evaluationsToResolve };
