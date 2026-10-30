'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const runRepository = require('./retention.run.repository');
const policyRepository = require('./retention.policy.repository');
const eligibility = require('./retention.eligibility');
const holdGuard = require('./retention.holdGuard');
const integration = require('./retention.integration');
const { dispose } = require('./retention.dispose');
const targets = require('./retention.targets');
const { ITEM_STATE, DISPOSITIONS } = require('./retention.constants');
const { todayInZone } = require('./retention.calendar');

const rows = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
const ids = (items) => items.map((item) => item.id);

/** Trava as linhas do alvo (o descarte e a reconferência valem sobre linha estável). ARCHIVE só copia: não trava (a tabela pode ser só de acréscimo). Devolve as chaves que existem. */
async function lockExisting(ctx, target, disposition, recordIds, transaction) {
  const lock = disposition === DISPOSITIONS.ARCHIVE ? '' : 'FOR UPDATE';
  const found = await rows(`SELECT t.id::text AS record_id FROM ${target.schema}.${target.table} t WHERE t.company_id = :companyId AND t.id IN (SELECT jsonb_array_elements_text(CAST(:ids AS jsonb))::uuid) ORDER BY t.id ${lock}`,
    { companyId: ctx.tenant.companyId, ids: JSON.stringify(recordIds) }, transaction);
  return new Set(found.map((row) => row.record_id));
}

/**
 * Um lote do apply (transação própria): confere de novo, DENTRO da transação, o que mudou desde a simulação e só então descarta. Pulados (e o motivo): política editada
 * (SKIPPED_POLICY_CHANGED), registro que sumiu (GONE), que deixou de ser elegível (NOT_ELIGIBLE), com exceção ativa (EXCEPTION) ou sob legal hold agora (HOLD).
 * Item de função (integração) chama a função única de retenção. Erro em qualquer ponto desfaz o lote inteiro.
 */
async function processBatch(ctx, runId, batch, transaction) {
  const { tenant, actor, now } = ctx;
  const items = await runRepository.batchItems(runId, batch, transaction);
  if (!items.length) return { done: 0, skipped: {} };
  const target = targets.get(batch.targetCode);
  const policy = await policyRepository.findByCode(tenant, items[0].policyCode, transaction);
  const summary = { done: 0, skipped: {} };
  const skip = async (list, state, reason) => { if (list.length) { await runRepository.markItems(ids(list), state, reason, null, transaction); summary.skipped[state] = (summary.skipped[state] || 0) + list.length; } };

  if (!policy || policy.version !== items[0].policyVersion) {
    await skip(items, ITEM_STATE.POLICY_CHANGED, 'A política foi editada depois da simulação.');
  } else if (targets.isFunction(target)) {
    const held = await holdGuard.heldIds(target.holdEntityType, items.map((item) => item.recordId), { tenant, transaction });
    const free = items.filter((item) => !held.includes(item.recordId));
    await skip(items.filter((item) => held.includes(item.recordId)), ITEM_STATE.HOLD, 'Bloqueio legal ativo.');
    for (const item of free) {
      const result = await integration.purge(tenant, transaction);
      await runRepository.markItems([item.id], ITEM_STATE.DONE, null, result, transaction);
      summary.done += 1;
    }
  } else {
    const existing = await lockExisting(ctx, target, policy.disposition, items.map((item) => item.recordId), transaction);
    await skip(items.filter((item) => !existing.has(item.recordId)), ITEM_STATE.GONE, 'O registro não existe mais.');
    const present = items.filter((item) => existing.has(item.recordId));
    const still = new Map((await eligibility.recheck(tenant, policy, target, todayInZone(now), present.map((item) => item.recordId), transaction)).map((row) => [row.record_id, row.has_exception]));
    await skip(present.filter((item) => !still.has(item.recordId)), ITEM_STATE.NOT_ELIGIBLE, 'O registro deixou de ser elegível.');
    const eligible = present.filter((item) => still.has(item.recordId));
    await skip(eligible.filter((item) => still.get(item.recordId)), ITEM_STATE.EXCEPTION, 'Exceção ativa.');
    const candidates = eligible.filter((item) => !still.get(item.recordId));
    const held = new Set(await holdGuard.heldIds(target.holdEntityType, candidates.map((item) => item.recordId), { tenant, transaction }));
    await skip(candidates.filter((item) => held.has(item.recordId)), ITEM_STATE.HOLD, 'Bloqueio legal ativo.');
    const go = candidates.filter((item) => !held.has(item.recordId));
    if (go.length) {
      const affected = await dispose({ tenant }, target, policy.disposition, go.map((item) => item.recordId), { policyCode: policy.code, runId }, transaction);
      await runRepository.markItems(ids(go), ITEM_STATE.DONE, null, null, transaction);
      summary.done += go.length;
      summary.affected = affected;
    }
  }
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId || null, action: 'governance.retention.batch', entityType: 'RetentionRun', entityId: runId,
    beforeJson: null, afterJson: { target: target.code, batchNo: batch.batchNo, disposition: policy ? policy.disposition : null, ...summary }, reason: `Lote ${batch.batchNo} de ${target.code} da retenção processado.`,
  }, transaction);
  await runRepository.heartbeat(runId, transaction);
  return summary;
}

module.exports = { processBatch };
