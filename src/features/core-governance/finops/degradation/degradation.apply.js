'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { AUDIT_ENTITY, AUDIT_APPLIED, AUDIT_REVERTED, STATUS } = require('./degradation.constants');
const { assertDegradable } = require('./prod.guard');
const { handlerOf } = require('./degradation.effects');
const repo = require('./degradation.repository');
const { setSwitch, syncAfterRevert } = require('../../feature-flags/flags.degradation');

const snapshot = (a) => ({ step: a.step, budgetId: a.budget_id, threshold: a.threshold, periodStart: String(a.period_start).slice(0, 10), status: a.status, previousValue: a.previous_value });

/**
 * Aplica UM passo da política (M9-D863 §3.3): primeiro a regra dura (só os cinco interruptores), depois a ação e a auditoria (antes e depois) na MESMA
 * transação do chamador. O passo já aplicado no período não é aplicado de novo (devolve null). Nada aqui toca infraestrutura.
 */
async function applyStep(tenant, ctx, transaction) {
  const step = assertDegradable(ctx.step);
  const handler = handlerOf(step);
  const previous = handler.capture(tenant, ctx.params);
  const action = await repo.insertAction(tenant, { ...ctx, step, previous }, transaction);
  if (!action) return null;
  handler.activate(tenant, ctx.params);
  await setSwitch(tenant, step, true, ctx.budgetId, transaction); // M9-D870: o interruptor do passo é flag do registro
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: AUDIT_APPLIED, entityType: AUDIT_ENTITY, entityId: action.id,
    beforeJson: { step, active: false, previousValue: previous }, afterJson: { ...snapshot(action), percent: ctx.percent },
    reason: `Degradação por custo: passo ${step} aplicado ao chegar a ${ctx.percent}% do orçamento (limiar ${ctx.threshold}%).`,
  }, transaction);
  return action;
}

/** Desfaz o passo: restaura o valor anterior guardado, marca REVERTED e audita antes e depois. */
async function revertAction(tenant, action, reason, now, transaction) {
  const done = await repo.markReverted(tenant, action.id, reason, now, transaction);
  if (!done) return null;
  handlerOf(action.step).deactivate(tenant, action.previous_value);
  await syncAfterRevert(tenant, action.step, action.budget_id, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: AUDIT_REVERTED, entityType: AUDIT_ENTITY, entityId: action.id,
    beforeJson: snapshot(action), afterJson: { ...snapshot(done), status: STATUS.REVERTED, restoredValue: action.previous_value, reason },
    reason: `Degradação por custo desfeita (${reason}): passo ${action.step} voltou ao valor anterior.`,
  }, transaction);
  return done;
}

module.exports = { applyStep, revertAction };
