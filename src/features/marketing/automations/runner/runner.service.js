'use strict';

const { sequelize } = require('../../../../models');
const logger = require('../../../../utils/logger');
const { consumeInboundEvent } = require('../../../../engines/events/inbox');
const { startRun, runIdempotencyKey, resolveTriggerEventId, prepareReplay, getRunnerTimeoutS } = require('../idempotency');
const { findCandidates, loadForRun } = require('./runner.load');
const { decide } = require('./runner.decide');
const { planEntries, summarize } = require('./runner.plan');
const { executePending } = require('./runner.exec');
const { writePlan, writeOutcome, lockRun, runsOfEvent } = require('./runner.persist');
const { emitStarted, emitEnd } = require('./runner.events');
const { readRunnerParams } = require('./runner.settings');
const { CONSUMER_NAME, STEPS } = require('./runner.constants');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** O inbox guarda o id do evento como uuid; o evento sintético da agenda (`sched:{fluxo}:{janela}`) ganha um uuid determinístico derivado do texto. */
function inboxIdOf(eventId) {
  if (UUID_RE.test(String(eventId))) return eventId;
  const h = require('node:crypto').createHash('sha256').update(String(eventId)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const NO_VERSION = Object.freeze({ code: 'MKT_NO_PUBLISHED_VERSION', message: 'Nenhuma versão publicada para este gatilho.' });

const setTenant = (tenant, transaction) => sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: tenant.groupId, c: tenant.companyId }, transaction });

/** Contexto comum dos passos: tenant da empresa do evento, relógio, sujeito, rastro e parâmetros do administrador. */
async function buildContext(input, transaction, options) {
  const tenant = input.tenant;
  return { tenant, transaction, now: options.now || new Date(), mode: options.mode, scenario: options.scenario, event: { ...input, payload: input.payload || {} }, subject: input.subject || null, trace: [], params: await readRunnerParams(tenant, transaction), correlationId: input.correlationId };
}

const view = (run, extra = {}) => ({ runId: run.id, flowId: run.flowId || null, status: run.status, blockedReason: run.blocked_reason || null, replay: false, ...extra });

/** Referências do payload que a espera precisa lembrar (o contrato do evento, para o executor das ações adiadas conferir). */
const refsOf = (payload) => (payload && payload.contractId ? { contractId: String(payload.contractId) } : {});

/**
 * Passos 2 a 9 de UMA versão para o evento. Insere a run (passo 6) DEPOIS das checagens, sempre: a run bloqueada nasce já BLOCKED com o motivo e o rastro. Conflito de chave =
 * replay: nada executa e nada é emitido. Devolve { runId, status, blockedReason, replay }.
 */
async function processVersion(ctx, cand) {
  const { flow, version } = cand;
  const decision = await decide(ctx, cand);
  const triggerEventId = resolveTriggerEventId({ triggerConfig: version.triggerConfig, payload: ctx.event.payload, eventId: ctx.event.eventId });
  const runKey = runIdempotencyKey({ automationVersionId: version.id, triggerEventId, subjectId: ctx.subject ? ctx.subject.id : null });
  const entries = planEntries(runKey, version.actions, decision, ctx);
  const blockedReason = decision.applicability || decision.runBlock || null;
  ctx.trace.push({ step: 6, name: STEPS[6], key: runKey, triggerEventId });

  const started = await startRun({ tenant: ctx.tenant, automationVersionId: version.id, eventId: ctx.event.eventId, triggerConfig: version.triggerConfig, payload: ctx.event.payload,
    subjectType: ctx.subject ? ctx.subject.type : null, subjectId: ctx.subject ? ctx.subject.id : null, correlationId: ctx.correlationId }, { transaction: ctx.transaction });
  const runRow = { id: started.run.id, correlation_id: started.run.correlationId, status: started.run.status, blocked_reason: started.run.blockedReason };
  if (started.replay) return view(runRow, { replay: true });

  await writePlan(runRow.id, { blockedReason, trace: ctx.trace, actionsResult: entries }, ctx.transaction);
  await emitStarted({ tenant: ctx.tenant, run: runRow, flow, version, subject: ctx.subject }, ctx.transaction);
  return { ...(await finishRun(ctx, { runRow, flow, version, entries, blockedReason })), flowId: flow.id };
}

/** Passos 7 a 9: executa o que falta, grava o resultado por ação, define o estado final e emite o evento de término (uma única vez). */
async function finishRun(ctx, { runRow, flow, version, entries, blockedReason }) {
  const done = await executePending({ ...ctx, run: runRow, flow, campaignId: version.triggerConfig && version.triggerConfig.campaignId }, entries, version.actions);
  const summary = summarize(done, blockedReason);
  ctx.trace.push({ step: 7, name: STEPS[7], executed: done.filter((e, i) => e.status !== entries[i].status).map((e) => ({ index: e.index, type: e.type, status: e.status })) });
  ctx.trace.push({ step: 8, name: STEPS[8], results: done.map((e) => ({ index: e.index, type: e.type, status: e.status, error_code: e.error_code })) });
  ctx.trace.push({ step: 9, name: STEPS[9], status: summary.status, event: { COMPLETED: 'automation.run.completed', BLOCKED: 'automation.run.blocked' }[summary.status] || null, refs: refsOf(ctx.event.payload) });
  await writeOutcome(runRow.id, { status: summary.status, blockedReason: summary.blockedReason, trace: ctx.trace, actionsResult: done, nextDueAt: summary.nextDueAt }, ctx.transaction);
  const error = (done.find((e) => ['FAILED', 'UNKNOWN'].includes(e.status)) || {}).detail;
  await emitEnd({ tenant: ctx.tenant, run: runRow, status: summary.status, blockedReason: summary.blockedReason, entries: done, error }, ctx.transaction);
  return view({ ...runRow, status: summary.status, blocked_reason: summary.blockedReason }, { actions: done });
}

/**
 * Entrada do runner (passo 1: receber). Deduplicação do inbox por eventId; sem fluxo ACTIVE com versão PUBLISHED para o gatilho nada acontece
 * (código MKT_NO_PUBLISHED_VERSION só no retorno e no log técnico). `input`: { eventId, eventType, subject, tenant, payload, correlationId }.
 * `candidates` (agenda) substitui a busca por tipo de evento.
 */
async function processEvent(input, transaction, options = {}) {
  await setTenant(input.tenant, transaction);
  let result = { runs: [] };
  const work = async () => {
    const candidates = options.candidates || await findCandidates(input.eventType, transaction);
    if (candidates.length === 0) {
      logger.debug({ eventType: input.eventType, code: NO_VERSION.code }, 'marketing.runner.no_published_version');
      result = { runs: [], ...NO_VERSION };
      return null;
    }
    const runs = [];
    for (const cand of candidates) {
      const ctx = await buildContext({ ...input, correlationId: input.correlationId || require('node:crypto').randomUUID() }, transaction, options);
      ctx.trace.push({ step: 1, name: STEPS[1], eventId: input.eventId, eventType: input.eventType, correlationId: ctx.correlationId, refs: refsOf(input.payload) });
      runs.push(await processVersion(ctx, cand));
    }
    result = { runs };
    return null;
  };
  let outcome;
  try {
    // savepoint: dois consumidores do mesmo evento ao mesmo tempo (a chave do inbox é única) — quem perde a corrida vira "duplicado", não erro
    outcome = await sequelize.transaction({ transaction }, (savepoint) => consumeInboundEvent({
      sourceId: CONSUMER_NAME, eventId: inboxIdOf(input.eventId), groupId: input.tenant.groupId, companyId: input.tenant.companyId, payload: { eventType: input.eventType, eventId: input.eventId }, transaction: savepoint,
    }, work));
  } catch (err) {
    if (!(err && err.parent && err.parent.code === '23505' && /inbox/.test(String(err.parent.constraint || '')))) throw err;
    outcome = { duplicate: true };
  }
  if (outcome.duplicate) {
    const existing = await runsOfEvent(input.tenant.companyId, input.eventId, transaction);
    return { duplicate: true, runs: existing.map((r) => ({ runId: r.id, status: r.status, blockedReason: r.blocked_reason, replay: true })) };
  }
  return { duplicate: false, ...result };
}

/**
 * Replay seguro de uma run (FAILED, ou STARTED travada pela regra da M9-D415): reexecuta SÓ as ações que não estão OK nem SKIPPED (a action_key é a mesma), reconcilia as
 * UNKNOWN pelo destino e fecha a run uma única vez. WAITING nunca entra aqui.
 */
async function replayRun(runId, tenant, transaction, options = {}) {
  await setTenant(tenant, transaction);
  const row = await lockRun(runId, transaction);
  if (!row) return null;
  const now = options.now || new Date();
  const timeoutS = await getRunnerTimeoutS(tenant, transaction);
  const plan = await prepareReplay({ run: { status: row.status, startedAt: row.started_at, finishedAt: row.finished_at, actionsResult: row.actions_result }, now, timeoutS });
  if (!plan.shouldReplay) return { runId: row.id, status: row.status, replayed: false };
  const cand = await loadForRun(row.automation_version_id, transaction);
  const subject = row.subject_id ? { type: row.subject_type, id: row.subject_id } : null;
  const ctx = await buildContext({ tenant, eventId: row.trigger_event_id, eventType: 'replay', subject, payload: {}, correlationId: row.correlation_id }, transaction, { ...options, now });
  const trace = Array.isArray(row.policy_trace) ? row.policy_trace : [];
  ctx.trace.push(...trace.filter((e) => e.step <= 6));
  const entries = plan.actionsResult.map((e) => (plan.pending.some((p) => p.actionKey === e.action_key) ? { ...e, status: 'PENDING', error_code: null } : e));
  const out = await finishRun(ctx, { runRow: { id: row.id, correlation_id: row.correlation_id, status: row.status }, flow: cand.flow, version: cand.version, entries, blockedReason: row.blocked_reason });
  return { ...out, replayed: true };
}

module.exports = { processEvent, processVersion, finishRun, replayRun, buildContext, setTenant };
