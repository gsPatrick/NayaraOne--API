'use strict';

const { withSavepoint } = require('./killswitch.savepoint');
const logger = require('../../utils/logger');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const flagsService = require('../core-governance/feature-flags/feature-flags.service');
const { ACTIONS, SOURCES, AUDIT } = require('./killswitch.constants');
const { lockTarget, writeColumns } = require('./killswitch.target');
const { insertLog, lastActivation } = require('./killswitch.log');
const hooks = require('./killswitch.hooks');
const errors = require('./killswitch.errors');

/** Grava o novo estado: flag do registro (versão, auditoria e histórico do D870) para GLOBAL e CHANNEL; colunas para CAMPAIGN e AUTOMATION. */
async function writeState(tenant, target, input, actorUserId, now, transaction) {
  if (target.kind === 'FLAG') {
    const reason = `${input.active ? 'Acionado' : 'Reativado'}: ${input.reason}`.slice(0, 500);
    await flagsService.updateEntry(tenant, { id: target.id, value: input.active, reason }, actorUserId, transaction, { now });
    return;
  }
  await writeColumns(tenant, input.scope, target.id, { active: input.active, actorUserId, reason: input.reason, at: now }, transaction);
}

/** Reativar um bloqueio que veio de incidente CRITICAL exige o incidente resolvido (M9-D425 "Incidente CRITICAL"); sem resolvedor vale "não resolvido". */
async function assertIncidentResolved(tenant, input, transaction) {
  const last = await lastActivation(tenant, input.scope, input.targetId, transaction);
  if (!last || last.source !== SOURCES.INCIDENT_CRITICAL) return;
  if (!await hooks.isIncidentResolved({ tenant, incidentId: last.incident_id, transaction })) throw errors.incidentOpen({ incidentId: last.incident_id });
}

/** Conta comprometida (M9-D433): chama o tratador registrado; a falha dele NÃO desfaz o bloqueio do canal. */
async function runCompromised(tenant, input, actorUserId, transaction) {
  const handler = hooks.getCompromisedHandler();
  if (!handler) return { handled: false, pending: true };
  try {
    const out = await withSavepoint(transaction, (tx) => handler({ tenant, channel: input.targetId, reason: input.reason, actorUserId, transaction: tx }));
    return { handled: true, ...(out && typeof out === 'object' ? out : {}) };
  } catch (err) {
    logger.error({ err: err && err.message, channel: input.targetId }, 'marketing.kill_switch.compromised_handler_failed');
    return { handled: false, error: err && err.code ? err.code : 'COMPROMISED_HANDLER_FAILED' };
  }
}

const viewOf = (input, target, extra) => ({
  scope: input.scope, targetId: input.targetId, targetCode: target.label, active: input.active, previouslyActive: target.active, changed: target.active !== input.active, ...extra,
});

/**
 * Aciona (`active:true`) ou reativa (`active:false`) um escopo do kill switch do Marketing (M9-D425). Tudo na transação do chamador: trava o alvo (FOR UPDATE), grava o estado,
 * o histórico e a auditoria com quem, quando, escopo, motivo e estado antes/depois. Acionar um escopo já ligado devolve o mesmo estado, sem nova auditoria (exceto quando um
 * incidente CRITICAL passa a ser o dono do bloqueio ou a conta do canal é marcada como comprometida). Reativar o que já está desligado também é no-op. Nenhuma configuração é apagada.
 * `input`: saída de parseChange. `source`/`incidentId`: origem do acionamento (padrão MANUAL).
 */
async function changeKillSwitch({ tenant, actorUserId, input, source = SOURCES.MANUAL, incidentId = null, transaction, now = new Date() }) {
  const effectiveSource = input.compromised && source === SOURCES.MANUAL ? SOURCES.COMPROMISED_ACCOUNT : source;
  const target = await lockTarget(tenant, input, actorUserId, transaction);
  if (!input.active) await assertIncidentResolved(tenant, input, transaction);
  const takesOwnership = input.active && target.active && (effectiveSource === SOURCES.INCIDENT_CRITICAL || input.compromised);
  if (target.active === input.active && !takesOwnership) return viewOf(input, target, { source: effectiveSource, logId: null });

  if (target.active !== input.active) await writeState(tenant, target, input, actorUserId, now, transaction);
  const entry = await insertLog(tenant, {
    scope: input.scope, targetId: input.targetId, action: input.active ? ACTIONS.ACTIVATE : ACTIONS.RESTORE, source: effectiveSource, incidentId,
    compromised: input.compromised, reason: input.reason, actorUserId, before: target.active, after: input.active,
  }, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actorUserId || null, action: AUDIT.changed, entityType: AUDIT.entity, entityId: target.id,
    beforeJson: { scope: input.scope, targetId: input.targetId, active: target.active },
    afterJson: { scope: input.scope, targetId: input.targetId, active: input.active, source: effectiveSource, incidentId, compromised: input.compromised, logId: entry.id },
    reason: input.reason,
  }, transaction);
  const compromised = input.active && input.compromised ? await runCompromised(tenant, input, actorUserId, transaction) : undefined;
  return viewOf(input, target, { source: effectiveSource, logId: entry.id, at: entry.created_at, ...(compromised ? { compromised } : {}) });
}

module.exports = { changeKillSwitch };
