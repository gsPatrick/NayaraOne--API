'use strict';

const { actionKey, nextDueAt } = require('../idempotency');
const { SEND, SEND_BLOCK_REASONS, APPLICABILITY_REASONS, NO_CADENCE_DAY } = require('./runner.constants');

/** Porta da cadência (M9-D422): `fn(def, ctx) -> Date|null` (pode ser assíncrona) devolve o horário em que a ação deve sair, ou null. Sem registro, nenhuma ação espera por cadência. */
let cadenceDueAt = async () => null;
const registerCadenceDue = (fn) => { cadenceDueAt = fn; };

const skip = (entry, reason) => ({ ...entry, status: 'SKIPPED', error_code: reason });
const schedule = (entry, dueAt) => ({ ...entry, status: 'SCHEDULED', due_at: new Date(dueAt).toISOString() });

/** Ação de envio de cadência: nasce SCHEDULED no horário da cadência, mesmo que já tenha passado (o executor das ações adiadas reavalia o canSend na hora do envio). Sem dia na lista, SKIPPED. */
async function planDeferred(entry, def, ctx) {
  const due = await cadenceDueAt(def, ctx);
  return due ? schedule(entry, due) : skip(entry, NO_CADENCE_DAY);
}

async function planOne(runKey, def, index, decision, ctx) {
  const type = def.actionType;
  let entry = { index, type, action_type: type, action_key: actionKey(runKey, index, type), status: 'PENDING', due_at: null, provider_ref: null, error_code: null };
  const send = decision.sends[index];
  if (type === SEND) entry = { ...entry, channel: send ? send.channel : null, purpose: send ? send.purpose : String(def.purpose || 'MARKETING').toUpperCase(), at: ctx.now.toISOString() };
  if (decision.applicability) return skip(entry, decision.applicability);
  if (type === SEND) {
    if (send && send.kind === 'blocked') return skip(entry, send.reason);
    if (decision.runBlock) return skip(entry, decision.runBlock);
    if (send && send.kind === 'delay') return schedule(entry, send.dueAt);
    if (send && send.kind === 'deferred') return planDeferred(entry, def, ctx);
  }
  const cadence = await cadenceDueAt(def, ctx);
  return cadence && new Date(cadence).getTime() > ctx.now.getTime() ? schedule(entry, cadence) : entry;
}

/**
 * Lista inicial de `actions_result` (passos 6 a 8): uma entrada por ação, com a action_key calculada UMA vez (e nunca trocada). A ação de envio guarda
 * canal, finalidade e horário (DI-D416-3). Aplicabilidade: tudo SKIPPED. Bloqueio de envio: a mensagem fica SKIPPED e as internas esperam a execução.
 * Horário de silêncio (ou cadência): a ação passa a SCHEDULED com o horário.
 */
async function planEntries(runKey, defs, decision, ctx) {
  const out = [];
  for (const [index, def] of defs.entries()) out.push(await planOne(runKey, def, index, decision, ctx));
  return out;
}

/**
 * Estado da run a partir das ações (passos 8 e 9). FAILED/UNKNOWN em alguma ação: FAILED (o resultado fica na run e na auditoria, sem evento). Alguma ação SCHEDULED:
 * WAITING até o menor due_at (sem evento de término). Senão BLOCKED quando a run tem motivo de aplicabilidade ou alguma mensagem ficou SKIPPED por bloqueio de envio;
 * COMPLETED nos demais casos. Devolve { status, blockedReason, nextDueAt }.
 */
function summarize(entries, blockedReason) {
  if (entries.some((e) => ['FAILED', 'UNKNOWN'].includes(e.status))) return { status: 'FAILED', blockedReason: blockedReason || null, nextDueAt: null };
  const dueAt = nextDueAt(entries);
  const skippedSend = entries.find((e) => e.type === SEND && e.status === 'SKIPPED' && SEND_BLOCK_REASONS.includes(e.error_code));
  const reason = (APPLICABILITY_REASONS.includes(blockedReason) && blockedReason) || (skippedSend && skippedSend.error_code) || (SEND_BLOCK_REASONS.includes(blockedReason) && blockedReason) || null;
  if (dueAt) return { status: 'WAITING', blockedReason: reason, nextDueAt: dueAt };
  return reason ? { status: 'BLOCKED', blockedReason: reason, nextDueAt: null } : { status: 'COMPLETED', blockedReason: null, nextDueAt: null };
}

/** { OK: 2, SKIPPED: 1 }: o resumo que vai no evento automation.run.completed. */
function actionsSummary(entries) {
  return entries.reduce((acc, e) => ({ ...acc, [e.status]: (acc[e.status] || 0) + 1 }), {});
}

module.exports = { planEntries, summarize, actionsSummary, registerCadenceDue };
