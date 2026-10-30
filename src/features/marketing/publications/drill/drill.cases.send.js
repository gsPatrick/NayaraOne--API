'use strict';

const { scheduledJobs, setParam, jobRow, resultRows } = require('./drill.fixture');
const { prepare, cycle, posts, settle, seconds, MS } = require('./drill.cycle');
const { sendToChannel } = require('../adapters');
const content = require('../../content');
const { operationOf } = require('./drill.cycle');
const { KEYS: WORKER } = require('../worker/worker.settings');
const { SLOW_MS_KEY } = require('../adapters/channel.settings');
const { readDrillParams } = require('./drill.settings');

/**
 * M9-D442 — cenários de resposta incerta ou repetida (TIMEOUT, UNKNOWN_*, DUPLICATE_KEY, SLOW). Cada um devolve { ok, obtained } e roda na transação descartável do ensaio.
 * Regra do livro (Guia §9): timeout vira UNKNOWN, a reconciliação consulta o canal pela chave ANTES de qualquer nova tentativa, e nunca existe segundo post.
 */
const outcomes = async (t, jobId) => (await resultRows(t, jobId)).map((r) => r.outcome).filter((o) => o !== 'METRICS');

/** Primeiro ciclo com o cenário injetado, depois os ciclos de reconciliação até o job fechar. */
async function injectThenSettle(t, env, scenario) {
  await prepare(t, env);
  const s = await scheduledJobs(t, env, env.channel, 1);
  const jobId = s.jobs[0];
  await cycle(t, env, { now: s.now, scenarios: [scenario] });
  const first = await jobRow(t, jobId);
  const after = await settle(t, env, jobId, { now: s.now });
  return { jobId, s, first, ...after };
}

const summary = async (t, env, r) => ({ status: r.job.status, tentativas: r.job.attempts, posts: posts(env), resultados: await outcomes(t, r.jobId), ciclos: r.cycles });

/** TIMEOUT: UNKNOWN, reconciliação, no máximo um post (o sandbox decide por hash se o pedido chegou ou não, e os dois caminhos acabam em um único post). */
async function timeout(t, env) {
  const r = await injectThenSettle(t, env, 'TIMEOUT');
  const sum = await summary(t, env, r);
  const ok = r.first.status === 'UNKNOWN' && r.job.status === 'PUBLISHED' && sum.posts === 1;
  return { ok, obtained: `1º ciclo: ${r.first.status} (${r.first.last_error_code}); depois ${JSON.stringify(sum)}` };
}

async function unknownButPublished(t, env) {
  const r = await injectThenSettle(t, env, 'UNKNOWN_BUT_PUBLISHED');
  const sum = await summary(t, env, r);
  const ok = r.first.status === 'UNKNOWN' && r.job.status === 'PUBLISHED' && sum.posts === 1 && sum.tentativas === 1 && sum.resultados.includes('RECONCILED_FOUND');
  return { ok, obtained: `1º ciclo: ${r.first.status}; reconciliado como já publicado; ${JSON.stringify(sum)}` };
}

async function unknownNotPublished(t, env) {
  const r = await injectThenSettle(t, env, 'UNKNOWN_NOT_PUBLISHED');
  const sum = await summary(t, env, r);
  const ok = r.first.status === 'UNKNOWN' && r.job.status === 'PUBLISHED' && sum.posts === 1 && sum.tentativas === 2 && sum.resultados.includes('RECONCILED_NOT_FOUND');
  return { ok, obtained: `1º ciclo: ${r.first.status}; ausência confirmada e reenviado uma vez; ${JSON.stringify(sum)}` };
}

/** DUPLICATE_KEY: o canal devolve o post original (mesma resposta) e o job fecha como publicado, sem segundo post; repetir o envio com a mesma chave devolve a mesma resposta. */
async function duplicateKey(t, env) {
  await prepare(t, env);
  const s = await scheduledJobs(t, env, env.channel, 1);
  const jobId = s.jobs[0];
  await cycle(t, env, { now: s.now, scenarios: ['DUPLICATE_KEY'] });
  const job = await jobRow(t, jobId);
  // a repetição sai pela mesma segunda barreira de conteúdo público que o worker usa
  const gateAdapter = { [operationOf(env.channel)]: (payload) => sendToChannel(env.channel, payload, { tenant: env.tenant, transaction: t, idempotencyKey: job.idempotency_key, circuit: null }) };
  const { result: again } = await content.adapterGate.deliverToAdapter(gateAdapter, operationOf(env.channel), { titulo: 'repetição', texto: 'repetição' }, { tenant: env.tenant, transaction: t });
  const same = again.providerRef === job.external_post_id && again.replayed === true;
  const ok = job.status === 'PUBLISHED' && same && posts(env) === 1;
  return { ok, obtained: `job ${job.status}; reenvio com a mesma chave: mesma resposta=${same}; posts=${posts(env)}` };
}

/** SLOW: a resposta passa do tempo máximo do worker e vale como TIMEOUT (UNKNOWN + reconciliação); o post tardio do canal não vira segundo post. */
async function slow(t, env) {
  await prepare(t, env);
  const { slowMarginMs } = await readDrillParams(env.tenant, t);
  const timeoutS = 1;
  await setParam(t, env, WORKER.timeout, timeoutS);
  await setParam(t, env, SLOW_MS_KEY, timeoutS * MS + slowMarginMs);
  const s = await scheduledJobs(t, env, env.channel, 1);
  const jobId = s.jobs[0];
  await cycle(t, env, { now: s.now, scenarios: ['SLOW'] });
  const first = await jobRow(t, jobId);
  await new Promise((resolve) => { setTimeout(resolve, slowMarginMs + 200); }); // o canal termina o post tardio, como faria de verdade
  const after = await settle(t, env, jobId, { now: s.now });
  const sum = { status: after.job.status, posts: posts(env), tentativas: after.job.attempts };
  const ok = first.status === 'UNKNOWN' && first.last_error_code === 'TIMEOUT' && after.job.status === 'PUBLISHED' && sum.posts === 1;
  return { ok, obtained: `resposta em ${timeoutS * MS + slowMarginMs} ms contra o limite de ${timeoutS * MS} ms: ${first.status}/${first.last_error_code}; depois ${JSON.stringify(sum)}` };
}

module.exports = { timeout, unknownButPublished, unknownNotPublished, duplicateKey, slow, seconds };
