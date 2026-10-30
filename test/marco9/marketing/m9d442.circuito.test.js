'use strict';

// M9-D442 — circuit breaker da conexão no worker de publicação: abre com 5xx contínuo, segura as publicações novas em PENDING (nenhuma perdida, nenhuma chamada ao canal),
// meia-abre depois do cooldown testando UMA chamada, reabre se o teste falha e fecha se dá certo. Banco descartável, transação com rollback.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktDrillEnv');
const { http5xx } = require('../../../src/features/marketing/publications/drill/drill.cases.circuit');
const messageCases = require('../../../src/features/marketing/publications/drill/drill.cases.message');
const { scheduledJobs, setParam } = require('../../../src/features/marketing/publications/drill/drill.fixture');
const { prepare, cycle, posts, seconds } = require('../../../src/features/marketing/publications/drill/drill.cycle');
const { query } = require('../../../src/features/marketing/publications/drill/drill.env');
const health = require('../../../src/features/integrations/health');
const { IntegrationConnection } = require('../../../src/models');
const { resolveChannelConnection } = require('../../../src/features/marketing/publications/schedule/schedule.connection');

let picked;
before(async () => { picked = await env.setup(); });
after(async () => { await sequelize.close(); });
afterEach(() => env.adapters.resetSandbox());

test('circuit_breaker_abre_e_meia_abre: 5xx contínuo no Instagram, 100 publicações esperam em PENDING e nada se perde', async () => {
  const e = env.envOf(picked, 'INSTAGRAM');
  const out = await env.withDrillTransaction(picked.tenant, async (t) => {
    await setParam(t, e, 'marketing.drill.jobs_pendentes', 100);
    return http5xx(t, e);
  });
  assert.equal(out.ok, true, out.obtained);
  assert.match(out.obtained, /circuito ABRIU/);
  assert.match(out.obtained, /100 de 100 publicações ficaram PENDING sem chamar o canal \(0 chamadas\)/);
  assert.match(out.obtained, /meia-abertura admitiu 1 chamada\(s\) de teste e o circuito ficou CLOSED/);
  assert.match(out.obtained, /no fim 105 de 105 publicadas, 105 posts, 0 perdidas/);
});

test('meia_abertura_que_falha_reabre_o_circuito_e_o_resto_segue_pendente', async () => {
  const e = env.envOf(picked, 'FACEBOOK');
  await env.withDrillTransaction(picked.tenant, async (t) => {
    await prepare(t, e);
    await setParam(t, e, 'integration.circuit.half_open_max_calls', 1);
    const ref = await resolveChannelConnection({ tenant: e.tenant, actor: null, channel: e.channel, transaction: t });
    const connection = await IntegrationConnection.findByPk(ref.id, { transaction: t });
    const hctx = { groupId: e.tenant.groupId, companyId: e.tenant.companyId, userId: null };
    const { failure_threshold: threshold, cooldown_s: cooldownS } = await health.resolveCircuitPolicy(hctx, connection, t);
    await setParam(t, e, 'marketing.worker.lote', threshold);
    const s = await scheduledJobs(t, e, e.channel, threshold + 3);
    await cycle(t, e, { now: s.now, scenarios: 'HTTP_5XX' });
    assert.equal((await health.getCurrentHealth(connection.id, hctx, t, { now: s.now })).circuitState, 'OPEN');
    const halfAt = seconds(s.now, cooldownS + 5);
    await cycle(t, e, { now: halfAt, scenarios: 'HTTP_5XX' }); // a chamada de teste também falha
    const after = await health.getCurrentHealth(connection.id, hctx, t, { now: halfAt });
    assert.equal(after.circuitState, 'OPEN', 'o teste falhou: o circuito reabre');
    const attempts = async () => Number((await query(t, 'SELECT COALESCE(sum(attempts), 0) AS n FROM marketing.publication_jobs WHERE id = ANY(CAST(:ids AS uuid[]))', { ids: `{${s.jobs.join(',')}}` }))[0].n);
    assert.equal(await attempts(), threshold + 1, 'as falhas que abriram o circuito mais exatamente UMA chamada de teste na meia-abertura');
    assert.equal(posts(e), 0, 'nada saiu para o canal');
    const total = (await query(t, "SELECT count(*)::int AS n FROM marketing.publication_jobs WHERE id = ANY(CAST(:ids AS uuid[])) AND status IN ('PENDING','RUNNING')", { ids: `{${s.jobs.join(',')}}` }))[0].n;
    assert.equal(total, threshold + 3, 'nenhuma publicação perdida: todas seguem esperando (PENDING)');
  });
});

test('429_nao_abre_o_circuito: limite do provedor não é falha do provedor', async () => {
  const e = env.envOf(picked, 'LINKEDIN');
  await env.withDrillTransaction(picked.tenant, async (t) => {
    await prepare(t, e);
    const ref = await resolveChannelConnection({ tenant: e.tenant, actor: null, channel: e.channel, transaction: t });
    const connection = await IntegrationConnection.findByPk(ref.id, { transaction: t });
    const hctx = { groupId: e.tenant.groupId, companyId: e.tenant.companyId, userId: null };
    const { failure_threshold: threshold } = await health.resolveCircuitPolicy(hctx, connection, t);
    await setParam(t, e, 'marketing.worker.lote', threshold + 2);
    const s = await scheduledJobs(t, e, e.channel, threshold + 2);
    await cycle(t, e, { now: s.now, scenarios: 'HTTP_429' });
    assert.equal((await health.getCurrentHealth(connection.id, hctx, t, { now: s.now })).circuitState, 'CLOSED');
  });
});

test('circuit_breaker_na_mensagem_direta: WhatsApp e e-mail, 5xx contínuo, envios novos recusados com 503 sem chamar o canal e sem gravar nada', async () => {
  for (const channel of ['WHATSAPP', 'EMAIL']) {
    const e = env.envOf(picked, channel);
    const out = await env.withDrillTransaction(picked.tenant, async (t) => {
      await setParam(t, e, 'marketing.drill.jobs_pendentes', 30);
      return messageCases.http5xx(t, e);
    });
    assert.equal(out.ok, true, `${channel}: ${out.obtained}`);
    assert.match(out.obtained, /circuito ABRIU/);
    assert.match(out.obtained, /30 de 30 envios novos recusados \(503\) sem chamar o canal e 0 gravados/);
    assert.match(out.obtained, /meia-abertura: 1 chamada de teste que falhou e o circuito reabriu/);
    assert.match(out.obtained, /o circuito ficou CLOSED/);
  }
});
