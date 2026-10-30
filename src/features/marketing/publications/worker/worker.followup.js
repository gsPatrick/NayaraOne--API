'use strict';

const { resolveChannelAdapter } = require('../adapters/release/channelAccess');
const { capabilitiesForChannel } = require('../adapters/ChannelAdapter');
const repo = require('./worker.repository');
const results = require('./worker.results');
const { acceptPost } = require('./worker.outcome');
const { escalate, shouldEscalate } = require('./worker.escalate');
const { statusKind } = require('./worker.status');
const { withTimeout } = require('./worker.call');
const logger = require('../../../../utils/logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const addSeconds = (date, s) => new Date(date.getTime() + s * 1000);

async function callAdapter(ctx, job, method, ...args) {
  try {
    const adapter = await resolveChannelAdapter(job.channel, { tenant: ctx.tenant, transaction: ctx.transaction });
    const outcome = await withTimeout(adapter[method](...args), ctx.params.timeoutS * 1000);
    return outcome.timedOut || outcome.error ? null : outcome.value;
  } catch (err) {
    logger.warn({ jobId: job.id, channel: job.channel, method, code: err && err.code }, 'marketing.publication.worker.followup_failed');
    return null;
  }
}

/**
 * Status real (M9-D411 item 8): post aceito e ainda em processamento é consultado por getStatus a cada `marketing.worker.reconcile_s`. No ar -> PUBLISHED ("Publicado" só
 * quando LIVE); recusado -> FAILED com o motivo; ainda processando -> segue RUNNING e, passado `marketing.worker.reconcile_max_h`, vira alerta crítico para decisão humana.
 */
async function statusOne(ctx, job) {
  const answer = await callAdapter(ctx, job, 'getStatus', job.external_post_id);
  const kind = answer && answer.found ? statusKind(answer.status) : 'PROCESSING';
  if (kind !== 'PROCESSING') return acceptPost(ctx, job, { providerRef: job.external_post_id, status: answer.status, externalUrl: answer.externalUrl || job.external_url, response: { statusCheck: true } });
  if (shouldEscalate(ctx, job, job.started_at)) return { to: 'RUNNING', escalated: true, ...(await escalate(ctx, job)) };
  await repo.patch(job.id, { nextCheckAt: addSeconds(ctx.now, ctx.params.reconcileS) }, ctx.transaction);
  return { to: 'RUNNING', processing: true };
}

async function statusDue(ctx) {
  const rows = await repo.selectStatusDue({ now: ctx.now, limit: ctx.params.batch }, ctx.transaction);
  const outcomes = [];
  for (const job of rows) outcomes.push(await statusOne(ctx, job));
  return outcomes;
}

/** O ponto D+N mais recente já vencido e ainda não coletado (coleta atrasada grava o ponto realmente alcançado, não os anteriores); null se nada a coletar. */
function dueDay(job, days, collected, now) {
  const age = now.getTime() - new Date(job.published_at).getTime();
  const reached = days.filter((d) => d * DAY_MS <= age);
  const day = reached.length ? reached[reached.length - 1] : null;
  return day === null || collected.includes(day) ? null : day;
}

/**
 * Métricas (M9-D411 item 7): job PUBLISHED é consultado por getMetrics nos dias de `marketing.worker.metricas_dias` (padrão D+0, D+1 e D+7 após a publicação), uma única
 * coleta por ponto, gravada como resultado METRICS em publication_results.metrics_json. Canal sem getMetrics não é consultado. Falha ou "não encontrado" tenta no ciclo seguinte.
 */
async function metricsOne(ctx, job) {
  if (!capabilitiesForChannel(job.channel).includes('getMetrics')) return null;
  const collected = await results.collectedDays(job.id, ctx.transaction);
  const day = dueDay(job, ctx.params.metricDays, collected, ctx.now);
  if (day === null) return null;
  const answer = await callAdapter(ctx, job, 'getMetrics', job.external_post_id);
  if (!answer || answer.found !== true) return { day, collected: false };
  await results.insertResult(job, {
    outcome: 'METRICS', attemptNo: job.attempts, externalPostId: job.external_post_id, externalUrl: job.external_url, providerStatus: job.provider_status,
    metrics: { day, collectedAt: ctx.now.toISOString(), metrics: answer.metrics || {} },
  }, ctx.transaction);
  return { day, collected: true };
}

async function metricsDue(ctx) {
  const lastDay = ctx.params.metricDays[ctx.params.metricDays.length - 1];
  const rows = await repo.selectMetricsCandidates({ since: new Date(ctx.now.getTime() - (lastDay + 1) * DAY_MS), points: ctx.params.metricDays.length, limit: ctx.params.batch }, ctx.transaction);
  const outcomes = [];
  for (const job of rows) {
    const outcome = await metricsOne(ctx, job);
    if (outcome) outcomes.push(outcome);
  }
  return outcomes;
}

module.exports = { statusDue, statusOne, metricsDue, metricsOne, dueDay };
