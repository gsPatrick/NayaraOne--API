'use strict';

const { runWorkerCycle } = require('../worker');
const adapters = require('../adapters');
const { runAsReleaseService } = require('../adapters/release/releaseScope');
const { releaseKey, CHANNEL_META } = require('../adapters/channels');
const { NOT_RELEASED } = require('../adapters/channel.settings');
const { setParam, jobRow } = require('./drill.fixture');

/**
 * M9-D442 — roda o worker de verdade nos cenários. O ensaio é SEMPRE no sandbox do canal (é o único que aceita cenário injetado): `prepare` desliga a liberação do canal dentro
 * da transação descartável, de modo que um canal já liberado também pode ser ensaiado sem tocar a produção. `scenarios`: cenário único, lista (um por tentativa) ou função do job.
 */
const MS = 1000;
const seconds = (date, s) => new Date(date.getTime() + s * MS);

async function prepare(t, env) {
  adapters.resetSandbox();
  await runAsReleaseService(() => setParam(t, env, releaseKey(env.channel), NOT_RELEASED));
}

function scenarioFor(scenarios) {
  return (job) => {
    const pick = typeof scenarios === 'function' ? scenarios(job) : scenarios;
    return Array.isArray(pick) ? (pick[job.attempts - 1] || undefined) : (pick || undefined);
  };
}

/** Um ciclo do worker na transação do ensaio, no instante `now` (o relógio é injetado: o ensaio não espera backoff nem cooldown de verdade). */
const cycle = (t, env, { now, scenarios } = {}) => runWorkerCycle(env.tenant, { withTx: (fn) => fn(t), now, scenarioFor: scenarioFor(scenarios) });

/** Quantos posts o sandbox do canal guarda para a empresa (o que "saiu" de verdade para o provedor simulado). */
const posts = (env) => adapters.sandboxRecordCount(env.tenant.companyId, env.channel);

const FINAL = Object.freeze(['PUBLISHED', 'FAILED', 'CANCELLED']);

/** Roda ciclos de `step` em `step` segundos até o job `jobId` chegar a um estado final (ou `max` ciclos). Devolve { job, now, cycles }. */
async function settle(t, env, jobId, { now, step = 70, max = 6 } = {}) {
  let at = now;
  let job = await jobRow(t, jobId);
  let cycles = 0;
  while (!FINAL.includes(job.status) && cycles < max) {
    at = seconds(at, step);
    await cycle(t, env, { now: at });
    job = await jobRow(t, jobId);
    cycles += 1;
  }
  return { job, now: at, cycles };
}

const operationOf = (channel) => CHANNEL_META[channel].operation;

module.exports = { prepare, cycle, posts, settle, seconds, operationOf, MS };
