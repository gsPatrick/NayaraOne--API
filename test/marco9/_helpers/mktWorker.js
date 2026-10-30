'use strict';

// Apoio dos testes M9-D411 (worker de publicação): item aprovado com jobs, ciclo do worker na transação do teste e leitura de job/resultados. Não é teste.
const env = require('./mktAgenda');
const publications = require('../../../src/features/marketing/publications');
const { runWorkerCycle } = require('../../../src/features/marketing/publications/worker');
const channelRegistry = require('../../../src/features/marketing/publications/adapters/registry/channelRegistry');
const { SandboxChannelAdapter } = require('../../../src/features/marketing/publications/adapters/sandbox/SandboxChannelAdapter');

const { fx } = env;
const MIN = 60000;
const HOUR = 60 * MIN;

/** Item aprovado e agendado em `channels` para daqui a 120 min; `now` do worker = 121 min (os jobs já venceram). */
async function scheduled(t, ctx, channels = ['SITE']) {
  const item = await env.approvedItem(t, ctx);
  const when = env.inMinutes(120);
  const out = await env.schedule(t, ctx, item.itemId, { channels, when: when.toISOString() });
  const now = new Date(when.getTime() + MIN);
  return { ...item, when, now, jobs: out.jobs, jobId: out.jobs[0].id };
}

/** Um ciclo do worker na transação do teste. `scenarios`: { CANAL: 'TIMEOUT' | ['TIMEOUT', null] } (lista = um por tentativa); só vale no sandbox. */
function cycle(t, ctx, { now, scenarios = {}, ...rest } = {}) {
  const scenarioFor = (job) => {
    const s = scenarios[job.channel] !== undefined ? scenarios[job.channel] : scenarios[job.id];
    return Array.isArray(s) ? (s[job.attempts - 1] || undefined) : (s || undefined);
  };
  return runWorkerCycle(ctx.tenant, { withTx: (fn) => fn(t), now, scenarioFor, ...rest });
}

const job = async (t, id) => (await fx.q(t, 'SELECT * FROM marketing.publication_jobs WHERE id = :id', { id }))[0];
const results = (t, jobId) => fx.q(t, 'SELECT * FROM marketing.publication_results WHERE job_id = :jobId ORDER BY occurred_at, created_at, attempt_no', { jobId });
const itemStatus = async (t, itemId) => (await fx.q(t, 'SELECT status FROM marketing.content_items WHERE id = :itemId', { itemId }))[0].status;
const setParam = (t, ctx, key, value) => require('../../../src/features/settings/settings.service').upsertSetting(key, value, ctx.tenant, ctx.tenant.userId, t);
const events = (t, jobId, type) => fx.q(t, "SELECT event_type, payload_json FROM integration.outbox_events WHERE aggregate_id = :jobId AND event_type = :type ORDER BY created_at", { jobId, type });

/** Troca o sandbox de um canal por uma subclasse (ex.: que responde PROCESSING) e devolve a função que restaura o original. */
function overrideSandbox(channel, make) {
  const original = channelRegistry.get(channel, 'SANDBOX');
  channelRegistry.register({ channel, mode: 'SANDBOX', create: (opts) => make(new SandboxChannelAdapter(channel, opts || {})) });
  return () => channelRegistry.register(original);
}

const seconds = (date, s) => new Date(date.getTime() + s * 1000);
const resetSandbox = () => publications.adapters.resetSandbox();

module.exports = { ...env, MIN, HOUR, scheduled, cycle, job, results, itemStatus, setParam, events, overrideSandbox, seconds, resetSandbox, runWorkerCycle };
