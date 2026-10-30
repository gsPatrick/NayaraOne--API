'use strict';

const { isOutboundBlocked } = require('../../killswitch.state');
const { getRunnerTimeoutS, isRunStuck } = require('../idempotency');
const { loadForRun } = require('./runner.load');
const { contractAllowsMessages } = require('./runner.contract');
const { decideSend } = require('./runner.decide');
const { summarize } = require('./runner.plan');
const { executePending } = require('./runner.exec');
const { lockDueRuns, lockStuckRuns, writeOutcome } = require('./runner.persist');
const { emitEnd } = require('./runner.events');
const { buildContext, setTenant, replayRun } = require('./runner.service');
const { SEND, STEPS, APPLICABILITY_REASONS } = require('./runner.constants');

const skip = (entry, reason) => ({ ...entry, status: 'SKIPPED', error_code: reason, due_at: null });

/** Precondição da automação que deixou de valer durante a espera (fluxo pausado, contrato que deixou de estar ativo). Devolve o motivo de aplicabilidade ou null. */
async function inapplicableNow(cand, row, transaction) {
  if (cand.flow.status !== 'ACTIVE') return 'AUTOMATION_PAUSED';
  const step1 = (Array.isArray(row.policy_trace) ? row.policy_trace : []).find((e) => e.step === 1) || {};
  const contractId = step1.refs && step1.refs.contractId;
  const cfg = cand.version.triggerConfig;
  if (contractId && (cfg.requireActiveContract || cfg.requireNoOpenOccurrence) && !(await contractAllowsMessages(contractId, row.subject_id, cfg, transaction))) return 'CONTRACT_NOT_ACTIVE';
  return null;
}

/** Reavalia UMA ação adiada vencida (envio: kill switch e canSend inteiro, inclusive o cap, na hora; interna: executa). Devolve a entrada atualizada. */
async function reevaluate(ctx, cand, entry, subject) {
  if (entry.type !== SEND) return { ...entry, status: 'PENDING', due_at: null };
  const def = cand.version.actions[entry.index] || {};
  const kill = await isOutboundBlocked(ctx.tenant, { channel: entry.channel, campaignId: cand.version.triggerConfig.campaignId, automationId: cand.flow.id }, ctx.transaction);
  if (kill.blocked) return skip(entry, 'KILL_SWITCH');
  const decision = await decideSend({ ...def, channel: entry.channel || def.channel, purpose: entry.purpose }, ctx, cand.version, subject, ctx.now);
  if (decision.kind === 'allowed') return { ...entry, channel: decision.channel, status: 'PENDING', due_at: null, at: ctx.now.toISOString() };
  if (decision.kind === 'delay') return { ...entry, due_at: new Date(decision.dueAt).toISOString() };
  return skip(entry, decision.reason);
}

async function processDueRun(row, tenant, transaction, options) {
  const cand = await loadForRun(row.automation_version_id, transaction);
  const subject = row.subject_id ? { type: row.subject_type, id: row.subject_id } : null;
  const refs = ((Array.isArray(row.policy_trace) ? row.policy_trace : []).find((e) => e.step === 1) || {}).refs || {}; // o que a run lembrou do evento (M9-D420/D421)
  const ctx = await buildContext({ tenant, eventId: row.trigger_event_id, eventType: 'due', subject, payload: refs, correlationId: row.correlation_id }, transaction, options);
  const reason = await inapplicableNow(cand, row, transaction);
  let blockedReason = row.blocked_reason;
  const entries = [];
  for (const entry of row.actions_result) {
    const due = entry.status === 'SCHEDULED' && entry.due_at && new Date(entry.due_at).getTime() <= ctx.now.getTime();
    if (reason && entry.status === 'SCHEDULED') entries.push(skip(entry, reason));
    else if (due) entries.push(await reevaluate(ctx, cand, entry, subject));
    else entries.push(entry);
  }
  if (reason) blockedReason = reason;
  const done = await executePending({ ...ctx, run: { id: row.id, correlation_id: row.correlation_id }, flow: cand.flow, campaignId: cand.version.triggerConfig.campaignId }, entries, cand.version.actions);
  const summary = summarize(done, blockedReason);
  const trace = [...(row.policy_trace || []), { step: 7, name: STEPS[7], origin: 'AUTOMATION_DUE_JOB', at: ctx.now.toISOString() }, { step: 8, name: STEPS[8], results: done.map((e) => ({ index: e.index, type: e.type, status: e.status, error_code: e.error_code })) },
    { step: 9, name: STEPS[9], status: summary.status, event: { COMPLETED: 'automation.run.completed', BLOCKED: 'automation.run.blocked' }[summary.status] || null }];
  const finalReason = summary.blockedReason || (APPLICABILITY_REASONS.includes(blockedReason) ? blockedReason : null);
  await writeOutcome(row.id, { status: summary.status, blockedReason: finalReason, trace, actionsResult: done, nextDueAt: summary.nextDueAt }, transaction);
  const error = (done.find((e) => ['FAILED', 'UNKNOWN'].includes(e.status)) || {}).detail;
  await emitEnd({ tenant, run: { id: row.id, correlation_id: row.correlation_id }, status: summary.status, blockedReason: finalReason, entries: done, error }, transaction);
}

/**
 * Executor das ações adiadas (automationDueJob, a cada 60 s): runs WAITING com `next_due_at` vencido, travadas com FOR UPDATE SKIP LOCKED. Cada ação SCHEDULED vencida é
 * reavaliada na hora (fluxo pausado, contrato, kill switch, canSend inteiro) e envia com a MESMA action_key, é reagendada ou fica SKIPPED com o motivo. Quando não resta ação
 * SCHEDULED a run vira COMPLETED ou BLOCKED e o evento correspondente sai uma única vez.
 */
async function runDueActions(tenant, transaction, options = {}) {
  await setTenant(tenant, transaction);
  const now = options.now || new Date();
  const rows = await lockDueRuns(now, transaction);
  for (const row of rows) await processDueRun(row, tenant, transaction, { ...options, now });
  return { processed: rows.length };
}

/** Run STARTED sem fim há mais que `marketing.runner.timeout_s` (padrão 300 s) é retomada só nas ações que faltam; WAITING nunca é tratada como travada. */
async function recoverStuckRuns(tenant, transaction, options = {}) {
  await setTenant(tenant, transaction);
  const now = options.now || new Date();
  const rows = await lockStuckRuns(now, await getRunnerTimeoutS(tenant, transaction), transaction);
  let replayed = 0;
  for (const row of rows) if ((await replayRun(row.id, tenant, transaction, { ...options, now })).replayed) replayed += 1;
  return { replayed };
}

module.exports = { runDueActions, recoverStuckRuns, isRunStuck };
