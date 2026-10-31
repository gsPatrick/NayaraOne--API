'use strict';

// M9-D411 — o worker reconfere kill switch, aprovação e conexão antes de enviar; envio social único; métricas D+0/D+1/D+7; parâmetros do worker.
// Banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d411.politicas.test.js
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktWorker');
const ks = require('../_helpers/m9d425Env');
const { adapters } = require('../../../src/features/marketing/publications');
const worker = require('../../../src/features/marketing/publications/worker');
const { sendJob } = require('../../../src/features/marketing/publications/worker/worker.call');
const { applySend } = require('../../../src/features/marketing/publications/worker/worker.outcome');
const repo = require('../../../src/features/marketing/publications/worker/worker.repository');

let ctx;
before(async () => { ctx = await env.setup(); });
after(async () => { await sequelize.close(); });
afterEach(() => { env.reset(); env.resetSandbox(); });

const posts = (channel) => adapters.sandboxRecordCount(ctx.tenant.companyId, channel);
const metricRows = async (t, jobId) => (await env.results(t, jobId)).filter((r) => r.outcome === 'METRICS');

test('kill_switch_global_segura_o_job_em_pending_sem_gastar_tentativa_e_publica_na_reativacao', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['SITE']);
    await ks.on(t, ctx.tenant, 'GLOBAL');
    const held = await env.cycle(t, ctx, { now: s.now });
    assert.equal(held.claimed, 0);
    let job = await env.job(t, s.jobId);
    assert.equal(job.status, 'PENDING', 'nem cancelado');
    assert.equal(job.attempts, 0, 'nem com tentativa gasta');
    assert.equal(posts('SITE'), 0);
    await ks.off(t, ctx.tenant, 'GLOBAL');
    await env.cycle(t, ctx, { now: env.seconds(s.now, 30) });
    job = await env.job(t, s.jobId);
    assert.equal(job.status, 'PUBLISHED', 'processado no ciclo seguinte à reativação, sem descarte');
    assert.equal(job.attempts, 1);
  });
});

test('kill_switch_do_canal_segura_so_aquele_canal_e_o_job_preso_nao_ocupa_o_lote', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    await env.setParam(t, ctx, 'marketing.worker.lote', 1);
    const s = await env.scheduled(t, ctx, ['INSTAGRAM', 'SITE']);
    await ks.on(t, ctx.tenant, 'CHANNEL', 'INSTAGRAM');
    await env.cycle(t, ctx, { now: s.now });
    const byChannel = Object.fromEntries(await Promise.all(s.jobs.map(async (j) => [j.channel, await env.job(t, j.id)])));
    assert.equal(byChannel.INSTAGRAM.status, 'PENDING');
    assert.equal(byChannel.INSTAGRAM.attempts, 0);
    assert.equal(byChannel.SITE.status, 'PUBLISHED', 'lote de 1: o canal segurado não bloqueia o outro');
  });
});

test('estado_ilegivel_do_kill_switch_segura_o_job', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['SITE']);
    await ks.withBrokenState(() => env.cycle(t, ctx, { now: s.now }));
    const job = await env.job(t, s.jobId);
    assert.equal(job.status, 'PENDING');
    assert.equal(job.attempts, 0);
  });
});

test('kill_switch_ligado_depois_da_reserva_devolve_o_job_a_pending_sem_tentativa_gasta', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['SITE']);
    await repo.patch(s.jobId, { status: 'RUNNING', attempts: 1, startedAt: s.now }, t);
    const claimed = (await repo.lockById(s.jobId, t));
    await ks.on(t, ctx.tenant, 'CHANNEL', 'SITE');
    const sent = await sendJob({ tenant: ctx.tenant, job: claimed, timeoutS: 30, transaction: t });
    assert.equal(sent.kind, 'RELEASE', 'o sendToChannel recusou com 423 antes de resolver o adapter');
    const applied = await applySend({ tenant: ctx.tenant, now: s.now, params: await worker.readWorkerParams(ctx.tenant, t), touched: new Set(), transaction: t }, claimed, sent);
    assert.equal(applied.released, true);
    const job = await env.job(t, s.jobId);
    assert.equal(job.status, 'PENDING');
    assert.equal(job.attempts, 0);
    assert.equal(posts('SITE'), 0);
  });
});

test('aprovacao_invalidada_depois_do_agendamento_cancela_o_job_e_nada_sai', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['SITE']);
    await env.fx.q(t, "UPDATE marketing.content_versions SET approved_hash = repeat('a', 64) WHERE id = :v", { v: s.versionId }); // o hash aprovado deixa de bater com o conteúdo
    await env.cycle(t, ctx, { now: s.now });
    const job = await env.job(t, s.jobId);
    assert.equal(job.status, 'CANCELLED');
    assert.equal(job.last_error_code, 'MKT_APPROVAL_INVALIDATED');
    assert.equal(job.attempts, 0);
    assert.equal(posts('SITE'), 0);
  });
});

test('backoff_usa_um_valor_por_retentativa_e_breaker_aberto_nao_conta_tentativa', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['SITE']);
    await env.cycle(t, ctx, { now: s.now, scenarios: { SITE: 'HTTP_5XX' } });
    let job = await env.job(t, s.jobId);
    assert.equal(job.attempts, 1);
    assert.equal(new Date(job.next_attempt_at).getTime(), env.seconds(s.now, 60).getTime());
    const [conn] = await env.fx.q(t, "SELECT id, group_id AS \"groupId\", company_id AS \"companyId\", provider_code AS \"providerCode\" FROM integration.connections WHERE company_id = :c AND provider_code = 'site-sandbox' AND status = 'ACTIVE' LIMIT 1", { c: ctx.tenant.companyId });
    const { ensureCurrentRow } = require('../../../src/features/integrations/health/healthStore');
    await ensureCurrentRow(conn, new Date(), t);
    await env.fx.q(t, "UPDATE integration.provider_health SET circuit_state = 'OPEN', circuit_opened_at = now(), circuit_cooldown_s = 86400, last_sample_at = now() WHERE connection_id = :id AND window_minutes = 0", { id: conn.id });
    for (let i = 1; i <= 4; i += 1) {
      await env.cycle(t, ctx, { now: env.seconds(s.now, 60 + i * 400), scenarios: { SITE: 'HTTP_5XX' } });
    }
    job = await env.job(t, s.jobId);
    assert.equal(job.status, 'PENDING', 'com o breaker aberto o job fica PENDING, nunca FAILED');
    assert.equal(job.attempts, 1, 'o breaker aberto não chama o adapter e não incrementa attempts');
    assert.equal(job.last_error_code, 'MKT_CHANNEL_CIRCUIT_OPEN', 'M9-D442: o worker consulta o circuit breaker (cooldown de um dia, ainda aberto) em vez de tratar a conexão como inativa');
    await env.fx.q(t, "UPDATE integration.provider_health SET circuit_state = 'CLOSED', circuit_opened_at = NULL WHERE connection_id = :id AND window_minutes = 0", { id: conn.id });
    await env.cycle(t, ctx, { now: env.seconds(s.now, 5000), scenarios: { SITE: 'OK' } });
    assert.equal((await env.job(t, s.jobId)).status, 'PUBLISHED', 'fechado o breaker, o job segue');
  });
});

test('rede_social_sai_uma_vez_so_pelo_canal_e_o_envio_da_rede_do_agendamento_sai_de_cena', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['INSTAGRAM', 'FACEBOOK']);
    const dispatches = () => env.fx.q(t, 'SELECT status FROM integration.dispatches WHERE aggregate_id = :i ORDER BY status', { i: s.itemId });
    assert.ok((await dispatches()).some((d) => d.status === 'PENDING'), 'o agendamento (M9-D410) deixa o envio da rede pendente');
    await env.cycle(t, ctx, { now: s.now });
    assert.ok((await dispatches()).every((d) => d.status === 'CANCELLED'), 'o worker envia pelo canal; o envio da rede não sai em duplicidade');
    assert.equal(posts('INSTAGRAM'), 1);
    assert.equal(posts('FACEBOOK'), 1);
  });
});

test('metricas_coletadas_em_d0_d1_e_d7', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['INSTAGRAM', 'SITE']);
    await env.cycle(t, ctx, { now: s.now });
    const day = 24 * env.HOUR;
    const jobId = s.jobs.find((j) => j.channel === 'INSTAGRAM').id;
    assert.deepEqual((await metricRows(t, jobId)).map((r) => r.metrics_json.day), [0], 'D+0 junto da publicação');
    await env.cycle(t, ctx, { now: new Date(s.now.getTime() + day - 60000) });
    assert.equal((await metricRows(t, jobId)).length, 1, 'antes de D+1 nada');
    await env.cycle(t, ctx, { now: new Date(s.now.getTime() + day) });
    await env.cycle(t, ctx, { now: new Date(s.now.getTime() + 3 * day) });
    assert.deepEqual((await metricRows(t, jobId)).map((r) => r.metrics_json.day), [0, 1]);
    await env.cycle(t, ctx, { now: new Date(s.now.getTime() + 7 * day) });
    await env.cycle(t, ctx, { now: new Date(s.now.getTime() + 9 * day) });
    const rows = await metricRows(t, jobId);
    assert.deepEqual(rows.map((r) => r.metrics_json.day), [0, 1, 7], 'coleta única em cada ponto');
    for (const row of rows) {
      assert.deepEqual(Object.keys(row.metrics_json.metrics).sort(), ['engagements', 'impressions', 'reach']);
      assert.ok(row.metrics_json.collectedAt);
    }
    // a lista é da empresa inteira (publicações de outros arquivos podem existir): localizo a publicação deste teste pelo id, na janela do seu horário
    const [{ scheduled_at: scheduledAt }] = await env.fx.q(t, 'SELECT scheduled_at FROM marketing.publication_jobs WHERE id = :id', { id: jobId });
    const list = await require('../../../src/features/marketing/publications').service.listPublications(ctx.tenant, { channel: 'INSTAGRAM', from: new Date(new Date(scheduledAt).getTime() - 1000).toISOString(), to: new Date(new Date(scheduledAt).getTime() + 1000).toISOString() }, t);
    const mine = list.items.find((item) => item.id === jobId);
    assert.ok(mine, 'a publicação do teste aparece na lista');
    assert.deepEqual(Object.keys(mine.metrics).sort(), ['engagements', 'impressions', 'reach'], 'a lista mostra as métricas da última coleta');
    const siteId = s.jobs.find((j) => j.channel === 'SITE').id;
    assert.equal((await metricRows(t, siteId)).length, 0, 'canal sem getMetrics não é consultado');
  });
});

test('os_dias_das_metricas_vem_de_parametro_e_coleta_atrasada_grava_so_o_ponto_alcancado', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    await env.setParam(t, ctx, 'marketing.worker.metricas_dias', '[0,2]');
    const s = await env.scheduled(t, ctx, ['LINKEDIN']);
    await env.cycle(t, ctx, { now: s.now });
    await env.cycle(t, ctx, { now: new Date(s.now.getTime() + 24 * env.HOUR) });
    assert.deepEqual((await metricRows(t, s.jobId)).map((r) => r.metrics_json.day), [0], 'D+1 não é ponto desta empresa');
    await env.cycle(t, ctx, { now: new Date(s.now.getTime() + 60 * env.HOUR) });
    assert.deepEqual((await metricRows(t, s.jobId)).map((r) => r.metrics_json.day), [0, 2], 'ciclo atrasado: grava o ponto D+2 já alcançado');
  });
});

test('parametros_do_worker_validam_na_escrita_e_o_codigo_so_os_le_do_dicionario', async () => {
  const ok = [['marketing.worker.intervalo_s', 30], ['marketing.worker.lote', 20], ['marketing.worker.backoff_s', '[60,300]'], ['marketing.worker.backoff_s', '10, 20, 30'], ['marketing.worker.max_tentativas', 3],
    ['marketing.worker.reconcile_s', 120], ['marketing.worker.reconcile_max_h', 24], ['marketing.worker.timeout_s', 30], ['marketing.worker.metricas_dias', '[0,1,7]']];
  const bad = [['marketing.worker.intervalo_s', 1], ['marketing.worker.lote', 0], ['marketing.worker.backoff_s', '[60,x]'], ['marketing.worker.backoff_s', '0'], ['marketing.worker.max_tentativas', 99],
    ['marketing.worker.metricas_dias', '[7,1]'], ['marketing.worker.metricas_dias', '-1'], ['marketing.worker.timeout_s', 0]];
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    for (const [key, value] of ok) await env.setParam(t, ctx, key, value);
    for (const [key, value] of bad) await assert.rejects(env.setParam(t, ctx, key, value), (e) => [400, 422].includes(e.statusCode), `${key}=${value}`);
  });
  for (const key of Object.keys(worker.WORKER_SETTING_DEFAULTS)) assert.ok(key in worker.WORKER_SETTINGS_SCHEMA, `${key} no dicionário`);
});
