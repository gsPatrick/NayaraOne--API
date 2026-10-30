'use strict';

// M9-D410 — agendamento e publication_jobs: um job por canal, chave de idempotência, um só job ativo por versão e canal, pré-condições.
// Banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d410.agendamento.test.js
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktAgenda');
const ks = require('../../../src/features/marketing/killswitch.service');
const { withBrokenState, change } = require('../_helpers/m9d425Env');

let ctx;
before(async () => { ctx = await env.setup(); });
after(async () => { await sequelize.close(); });
afterEach(env.reset);

const jobsOf = (t, itemId) => env.fx.q(t, `SELECT j.* FROM marketing.publication_jobs j JOIN marketing.content_versions v ON v.id = j.content_version_id WHERE v.content_item_id = :i ORDER BY j.channel, j.scheduled_at`, { i: itemId });

test('agendar_em_dois_canais_cria_dois_jobs_com_chave_e_conexao', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const item = await env.approvedItem(t, ctx);
    const when = env.inMinutes(120);
    const out = await env.schedule(t, ctx, item.itemId, { channels: ['SITE', 'INSTAGRAM'], when: when.toISOString() });
    assert.equal(out.status, 'SCHEDULED');
    assert.equal(out.jobs.length, 2);
    const jobs = await jobsOf(t, item.itemId);
    assert.deepEqual(jobs.map((j) => j.channel), ['INSTAGRAM', 'SITE']);
    for (const j of jobs) {
      assert.equal(j.status, 'PENDING');
      assert.equal(j.idempotency_key, `pub:${item.versionId}:${j.channel}:${when.toISOString()}`);
      assert.ok(j.connection_id, 'o job nasce ligado à conexão ativa do canal');
    }
  });
});

test('agendar_duas_vezes_devolve_o_mesmo_job', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const item = await env.approvedItem(t, ctx);
    const body = { channels: ['SITE'], when: env.inMinutes(90).toISOString() };
    const first = await env.schedule(t, ctx, item.itemId, body);
    const second = await env.schedule(t, ctx, item.itemId, body);
    assert.equal(first.replay, false);
    assert.equal(second.replay, true);
    assert.equal(second.jobs[0].id, first.jobs[0].id);
    assert.equal((await jobsOf(t, item.itemId)).length, 1);
  });
});

test('mesmo_evento_2x_uma_mensagem_ou_post: o mesmo post agendado duas vezes gera uma única linha pela chave do job', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const item = await env.approvedItem(t, ctx);
    const body = { channels: ['SITE', 'FACEBOOK'], when: env.inMinutes(75).toISOString() };
    await env.schedule(t, ctx, item.itemId, body);
    await env.schedule(t, ctx, item.itemId, body);
    const keys = (await jobsOf(t, item.itemId)).map((j) => j.idempotency_key);
    assert.equal(keys.length, 2);
    assert.equal(new Set(keys).size, 2);
  });
});

test('mesma_versao_e_canal_em_horarios_diferentes_e_recusada', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const item = await env.approvedItem(t, ctx);
    await env.schedule(t, ctx, item.itemId, { channels: ['SITE'], when: env.inMinutes(60).toISOString() });
    await env.rejectsCode(env.schedule(t, ctx, item.itemId, { channels: ['SITE'], when: env.inMinutes(180).toISOString() }), 409, 'MKT_JOB_ALREADY_ACTIVE');
    const jobs = await jobsOf(t, item.itemId);
    assert.equal(jobs.filter((j) => ['PENDING', 'RUNNING', 'UNKNOWN'].includes(j.status)).length, 1, 'um único job ativo');
    // o canal que ainda não tem job ativo segue permitido no mesmo item
    const more = await env.schedule(t, ctx, item.itemId, { channels: ['LINKEDIN'], when: env.inMinutes(180).toISOString() });
    assert.equal(more.replay, false);
    assert.equal((await jobsOf(t, item.itemId)).length, 2);
  });
});

test('o_banco_recusa_dois_jobs_ativos_da_mesma_versao_e_canal', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const item = await env.approvedItem(t, ctx);
    const insert = (key) => env.fx.q(t, `INSERT INTO marketing.publication_jobs (group_id, company_id, content_version_id, channel, adapter_code, status, idempotency_key, scheduled_at)
      VALUES (:g, :c, :v, 'SITE', 'site-sandbox', 'PENDING', :k, now() + interval '1 day') RETURNING id`, { g: ctx.tenant.groupId, c: ctx.tenant.companyId, v: item.versionId, k: key });
    await insert(`pub:${item.versionId}:SITE:2030-01-01T10:00:00.000Z`);
    await sequelize.query('SAVEPOINT dup', { transaction: t });
    await assert.rejects(insert(`pub:${item.versionId}:SITE:2030-01-01T11:00:00.000Z`), /mkt_publication_jobs_active_version_channel_uq/);
    await sequelize.query('ROLLBACK TO SAVEPOINT dup', { transaction: t });
  });
});

test('item_nao_aprovado_recusa_com_409', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const item = await env.pendingItem(t, ctx);
    await env.rejectsCode(env.schedule(t, ctx, item.itemId, { channels: ['SITE'], when: env.inMinutes(60).toISOString() }), 409, 'MKT_CONTENT_NOT_APPROVED');
    assert.equal((await jobsOf(t, item.itemId)).length, 0);
  });
});

test('agendamento_com_kill_switch_recusa: global, canal e estado ilegivel dao 423 MKT_KILL_SWITCH_ACTIVE e nenhum job nasce', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const item = await env.approvedItem(t, ctx);
    const body = { channels: ['SITE', 'INSTAGRAM'], when: env.inMinutes(60).toISOString() };
    await change(t, ctx.tenant, { scope: 'CHANNEL', targetId: 'INSTAGRAM', active: true });
    await env.rejectsCode(env.schedule(t, ctx, item.itemId, body), 423, 'MKT_KILL_SWITCH_ACTIVE');
    await change(t, ctx.tenant, { scope: 'CHANNEL', targetId: 'INSTAGRAM', active: false });
    await change(t, ctx.tenant, { scope: 'GLOBAL', active: true });
    await env.rejectsCode(env.schedule(t, ctx, item.itemId, body), 423, 'MKT_KILL_SWITCH_ACTIVE');
    await change(t, ctx.tenant, { scope: 'GLOBAL', active: false });
    await withBrokenState(() => env.rejectsCode(env.schedule(t, ctx, item.itemId, body), 423, 'MKT_KILL_SWITCH_ACTIVE'));
    assert.equal((await jobsOf(t, item.itemId)).length, 0);
    assert.equal(typeof ks.assertOutboundAllowed, 'function');
    assert.equal((await env.schedule(t, ctx, item.itemId, body)).status, 'SCHEDULED');
  });
});

test('conexao_do_canal_inativa_recusa_com_409_e_nenhum_job_nasce', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const first = await env.approvedItem(t, ctx);
    await env.schedule(t, ctx, first.itemId, { channels: ['SITE'], when: env.inMinutes(60).toISOString() }); // cria a conexão sandbox do canal
    await env.fx.q(t, "UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND provider_code = 'site-sandbox'", { c: ctx.tenant.companyId });
    const other = await env.approvedItem(t, ctx);
    await env.rejectsCode(env.schedule(t, ctx, other.itemId, { channels: ['SITE'], when: env.inMinutes(60).toISOString() }), 409, 'MKT_CHANNEL_CONNECTION_INACTIVE');
    assert.equal((await jobsOf(t, other.itemId)).length, 0);
  });
});

test('conexao_com_circuito_aberto_e_saude_DOWN_recusa_com_409', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const first = await env.approvedItem(t, ctx);
    await env.schedule(t, ctx, first.itemId, { channels: ['SITE'], when: env.inMinutes(60).toISOString() });
    const [conn] = await env.fx.q(t, "SELECT id, group_id AS \"groupId\", company_id AS \"companyId\", provider_code AS \"providerCode\" FROM integration.connections WHERE company_id = :c AND provider_code = 'site-sandbox' AND status = 'ACTIVE' LIMIT 1", { c: ctx.tenant.companyId });
    const { ensureCurrentRow } = require('../../../src/features/integrations/health/healthStore');
    await ensureCurrentRow(conn, new Date(), t);
    await env.fx.q(t, "UPDATE integration.provider_health SET circuit_state = 'OPEN', circuit_opened_at = now(), circuit_cooldown_s = 600, last_sample_at = now() WHERE connection_id = :id AND window_minutes = 0", { id: conn.id });
    const other = await env.approvedItem(t, ctx);
    await env.rejectsCode(env.schedule(t, ctx, other.itemId, { channels: ['SITE'], when: env.inMinutes(60).toISOString() }), 409, 'MKT_CHANNEL_CONNECTION_INACTIVE');
  });
});

test('falha_em_uma_rede_nao_bloqueia_outras: o job da rede com falha de envio fica FAILED e os demais seguem PENDING', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const item = await env.approvedItem(t, ctx);
    const social = require('../../../src/features/integrations/social');
    const original = social.publishToSocial;
    social.publishToSocial = async (context, args) => ({
      contentItemId: args.contentItemId, results: args.connectionIds.map((id) => ({ connectionId: id, ok: false, code: 'INTEGRATION_SOCIAL_NETWORK_FAILED', message: 'falha simulada' })),
    });
    let out;
    try { out = await env.schedule(t, ctx, item.itemId, { channels: ['SITE', 'INSTAGRAM'], when: env.inMinutes(60).toISOString() }); } finally { social.publishToSocial = original; }
    const jobs = await jobsOf(t, item.itemId);
    assert.equal(jobs.find((j) => j.channel === 'SITE').status, 'PENDING');
    const insta = jobs.find((j) => j.channel === 'INSTAGRAM');
    assert.equal(insta.status, 'FAILED');
    assert.equal(insta.last_error_code, 'INTEGRATION_SOCIAL_NETWORK_FAILED');
    assert.equal(out.status, 'SCHEDULED');
  });
});
