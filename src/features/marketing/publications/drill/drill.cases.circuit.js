'use strict';

const { IntegrationConnection } = require('../../../../models');
const health = require('../../../integrations/health');
const { resolveChannelConnection } = require('../schedule/schedule.connection');
const { KEYS: WORKER } = require('../worker/worker.settings');
const { scheduledJobs, setParam } = require('./drill.fixture');
const { prepare, cycle, posts, seconds } = require('./drill.cycle');
const { query } = require('./drill.env');
const { readDrillParams } = require('./drill.settings');

/**
 * M9-D442 — HTTP_5XX contínuo. O circuit breaker é o da política da conexão (framework de Integrações, M9-D217): as falhas seguidas do provedor o abrem, os envios que ainda não
 * saíram ficam PENDING sem perda e sem chamar o canal, e passado o cooldown a meia-abertura admite só as chamadas de teste (a vaga é `half_open_max_calls`; o ensaio a fixa em 1,
 * como o livro descreve). Teste que dá certo fecha o circuito e o resto da fila sai, cada publicação uma vez.
 */
const HALF_OPEN_KEY = 'integration.circuit.half_open_max_calls';
const states = async (t, ids) => (await query(t, 'SELECT status, attempts FROM marketing.publication_jobs WHERE id = ANY(CAST(:ids AS uuid[]))', { ids: `{${ids.join(',')}}` }));

async function http5xx(t, env) {
  await prepare(t, env);
  const { pendingJobs } = await readDrillParams(env.tenant, t);
  await setParam(t, env, HALF_OPEN_KEY, 1);
  const ref = await resolveChannelConnection({ tenant: env.tenant, actor: null, channel: env.channel, transaction: t });
  const connection = await IntegrationConnection.findByPk(ref.id, { transaction: t });
  const hctx = { groupId: env.tenant.groupId, companyId: env.tenant.companyId, userId: null };
  const policy = await health.resolveCircuitPolicy(hctx, connection, t);
  const threshold = policy.failure_threshold;
  const total = threshold + pendingJobs;
  await setParam(t, env, WORKER.batch, threshold); // o 1º ciclo pega só as publicações que vão falhar até abrir o circuito
  const s = await scheduledJobs(t, env, env.channel, total);
  const state = async (at) => (await health.getCurrentHealth(connection.id, hctx, t, { now: at })).circuitState;

  await cycle(t, env, { now: s.now, scenarios: 'HTTP_5XX' });
  const opened = (await state(s.now)) === 'OPEN';
  const callsBlocked = await cycle(t, env, { now: seconds(s.now, 5), scenarios: 'OK' });
  const waiting = (await states(t, s.jobs)).filter((j) => j.status === 'PENDING' && j.attempts === 0).length;
  const reached = posts(env);

  const halfAt = seconds(s.now, policy.cooldown_s + 5);
  await cycle(t, env, { now: halfAt, scenarios: 'OK' });
  const probeCalls = posts(env);
  const afterProbe = await state(halfAt);

  await setParam(t, env, WORKER.batch, total);
  await cycle(t, env, { now: seconds(halfAt, 5), scenarios: 'OK' });
  const finalStates = await states(t, s.jobs);
  const published = finalStates.filter((j) => j.status === 'PUBLISHED').length;
  const ok = opened && callsBlocked.sent === 0 && waiting === pendingJobs && reached === 0 && probeCalls === 1 && afterProbe === 'CLOSED' && finalStates.length === total && published === total && posts(env) === total;
  return {
    ok,
    obtained: `circuito ${opened ? 'ABRIU' : 'NÃO abriu'} após ${threshold} falhas; ${waiting} de ${pendingJobs} publicações ficaram PENDING sem chamar o canal (${reached} chamadas); meia-abertura admitiu ${probeCalls} chamada(s) de teste e o circuito ficou ${afterProbe}; no fim ${published} de ${total} publicadas, ${posts(env)} posts, ${total - finalStates.length} perdidas`,
  };
}

module.exports = { http5xx };
