'use strict';

// M9-D410 — status do item derivado dos jobs, cancelamento de job, listagem e envio das redes sociais (um envio por rede e cancelamento).
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktAgenda');
const pubs = require('../../../src/features/marketing/publications');

let ctx;
before(async () => { ctx = await env.setup(); });
after(async () => { await sequelize.close(); });
afterEach(env.reset);

const { deriveItemStatus } = pubs.service;
const cancel = (t, jobId, reason) => pubs.service.cancelJob({ tenant: ctx.tenant, actor: ctx.reviewer, jobId, reason }, t);
const setJob = (t, id, status, extra = '') => env.fx.q(t, `UPDATE marketing.publication_jobs SET status = :s ${extra} WHERE id = :id`, { s: status, id });
const itemStatus = async (t, id) => (await env.fx.q(t, 'SELECT status FROM marketing.content_items WHERE id = :id', { id }))[0].status;

test('deriveItemStatus: ignora CANCELLED, PUBLISHED so com todos publicados, FAILED so com todos terminados', () => {
  assert.equal(deriveItemStatus([], 'SCHEDULED'), null);
  assert.equal(deriveItemStatus(['CANCELLED', 'CANCELLED'], 'SCHEDULED'), null);
  assert.equal(deriveItemStatus(['PUBLISHED', 'CANCELLED'], 'PUBLISHING'), 'PUBLISHED');
  assert.equal(deriveItemStatus(['PUBLISHED', 'FAILED', 'CANCELLED'], 'PUBLISHING'), 'FAILED');
  assert.equal(deriveItemStatus(['FAILED'], 'PUBLISHING'), 'FAILED');
  assert.equal(deriveItemStatus(['PUBLISHED', 'PENDING'], 'PUBLISHING'), 'PUBLISHING');
  assert.equal(deriveItemStatus(['PUBLISHED', 'UNKNOWN'], 'PUBLISHING'), 'PUBLISHING');
  assert.equal(deriveItemStatus(['RUNNING', 'PENDING'], 'SCHEDULED'), 'PUBLISHING');
  assert.equal(deriveItemStatus(['PENDING', 'PENDING'], 'SCHEDULED'), 'SCHEDULED');
  assert.equal(deriveItemStatus(['PUBLISHED', 'FAILED', 'PENDING'], 'PUBLISHING'), 'PUBLISHING');
});

test('item_com_jobs_cancelados_e_publicados_fica_published', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const item = await env.approvedItem(t, ctx);
    const out = await env.schedule(t, ctx, item.itemId, { channels: ['SITE', 'INSTAGRAM'], when: env.inMinutes(60).toISOString() });
    const site = out.jobs.find((j) => j.channel === 'SITE');
    const insta = out.jobs.find((j) => j.channel === 'INSTAGRAM');
    await setJob(t, site.id, 'PUBLISHED', ", external_post_id = 'p1'");
    await env.fx.q(t, "UPDATE marketing.content_items SET status = 'PUBLISHING' WHERE id = :id", { id: item.itemId });
    const cancelled = await cancel(t, insta.id, 'Motivo do cancelamento do teste.');
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.itemStatus, 'PUBLISHED');
    assert.equal(await itemStatus(t, item.itemId), 'PUBLISHED');
  });
});

test('todos_os_jobs_cancelados_devolvem_o_item_a_APPROVED_e_permitem_agendar_de_novo_no_mesmo_horario', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const item = await env.approvedItem(t, ctx);
    const body = { channels: ['SITE', 'LINKEDIN'], when: env.inMinutes(60).toISOString() };
    const out = await env.schedule(t, ctx, item.itemId, body);
    await cancel(t, out.jobs[0].id);
    assert.equal(await itemStatus(t, item.itemId), 'SCHEDULED', 'ainda há um job ativo');
    const last = await cancel(t, out.jobs[1].id);
    assert.equal(last.itemStatus, 'APPROVED');
    const [row] = await env.fx.q(t, 'SELECT checks_json ? \'schedule\' AS has FROM marketing.content_versions WHERE id = :v', { v: item.versionId });
    assert.equal(row.has, false, 'o passo de agendamento sai do histórico para poder agendar de novo');
    const again = await env.schedule(t, ctx, item.itemId, body);
    assert.equal(again.status, 'SCHEDULED');
    assert.equal(again.replay, false);
    const jobs = await env.fx.q(t, 'SELECT status FROM marketing.publication_jobs WHERE content_version_id = :v', { v: item.versionId });
    assert.deepEqual(jobs.map((j) => j.status), ['PENDING', 'PENDING']);
  });
});

test('cancelar_job_em_execucao_recusa: RUNNING, PUBLISHED e FAILED dao 409 MKT_JOB_NOT_CANCELLABLE', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const item = await env.approvedItem(t, ctx);
    const out = await env.schedule(t, ctx, item.itemId, { channels: ['SITE', 'LINKEDIN', 'FACEBOOK'], when: env.inMinutes(60).toISOString() });
    const [a, b, c] = out.jobs;
    await setJob(t, a.id, 'RUNNING');
    await setJob(t, b.id, 'PUBLISHED');
    await setJob(t, c.id, 'FAILED');
    for (const job of [a, b, c]) await env.rejectsCode(cancel(t, job.id), 409, 'MKT_JOB_NOT_CANCELLABLE');
    await env.rejectsCode(cancel(t, '00000000-0000-4000-8000-000000000000'), 404, 'MKT_NOT_FOUND');
  });
});

test('job_UNKNOWN_so_cancela_depois_da_reconciliacao', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const item = await env.approvedItem(t, ctx);
    const out = await env.schedule(t, ctx, item.itemId, { channels: ['LINKEDIN'], when: env.inMinutes(60).toISOString() });
    const job = out.jobs[0];
    await setJob(t, job.id, 'UNKNOWN');
    await env.rejectsCode(cancel(t, job.id), 409, 'MKT_JOB_NOT_CANCELLABLE');
    await env.fx.q(t, `INSERT INTO marketing.publication_results (group_id, company_id, job_id, attempt_no, outcome) VALUES (:g, :c, :j, 1, 'RECONCILED_NOT_FOUND')`, { g: ctx.tenant.groupId, c: ctx.tenant.companyId, j: job.id });
    assert.equal((await cancel(t, job.id, 'Conferido na rede: o post não existe.')).status, 'CANCELLED');
  });
});

test('o_cancelamento_e_auditado_com_antes_e_depois_e_motivo', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const item = await env.approvedItem(t, ctx);
    const out = await env.schedule(t, ctx, item.itemId, { channels: ['SITE'], when: env.inMinutes(60).toISOString() });
    await cancel(t, out.jobs[0].id, 'Cliente pediu para segurar a publicação.');
    const [row] = await env.fx.q(t, "SELECT before_json, after_json, reason FROM audit.audit_log WHERE entity_id = :id AND action = 'marketing.publication.cancel'", { id: out.jobs[0].id });
    assert.equal(row.before_json.status, 'PENDING');
    assert.equal(row.after_json.status, 'CANCELLED');
    assert.match(row.reason, /segurar a publicação/);
  });
});

test('listagem: pagina, ordena por horario, filtra e traz externalPostId, externalUrl, metricas e horario de Sao Paulo', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const item = await env.approvedItem(t, ctx);
    const out = await env.schedule(t, ctx, item.itemId, { channels: ['SITE', 'LINKEDIN'], when: env.inMinutes(60).toISOString() });
    const site = out.jobs.find((j) => j.channel === 'SITE');
    await setJob(t, site.id, 'PUBLISHED', ", external_post_id = 'post-1'");
    await env.fx.q(t, `INSERT INTO marketing.publication_results (group_id, company_id, job_id, attempt_no, outcome, external_post_id, external_url, metrics_json)
      VALUES (:g, :c, :j, 1, 'SUCCESS', 'post-1', 'https://exemplo.test/post-1', '{"impressions": 120}'::jsonb)`, { g: ctx.tenant.groupId, c: ctx.tenant.companyId, j: site.id });
    const all = await pubs.service.listPublications(ctx.tenant, {}, t);
    const mine = all.items.filter((i) => i.contentItemId === item.itemId);
    assert.equal(mine.length, 2);
    const published = mine.find((i) => i.channel === 'SITE');
    assert.equal(published.externalPostId, 'post-1');
    assert.equal(published.externalUrl, 'https://exemplo.test/post-1');
    assert.deepEqual(published.metrics, { impressions: 120 });
    assert.match(published.scheduledAtLocal, /-03:00$/);
    assert.equal(all.pagination.pageSize, 50);
    const filtered = await pubs.service.listPublications(ctx.tenant, { status: 'PUBLISHED', channel: 'SITE' }, t);
    assert.ok(filtered.items.every((i) => i.status === 'PUBLISHED' && i.channel === 'SITE'));
    const one = await pubs.service.listPublications(ctx.tenant, { pageSize: 1 }, t);
    assert.equal(one.items.length, 1);
    const capped = await pubs.service.listPublications(ctx.tenant, { pageSize: 5000 }, t);
    assert.equal(capped.pagination.pageSize, 200);
    const dates = all.items.map((i) => i.scheduledAt);
    assert.deepEqual(dates, [...dates].sort());
    await assert.rejects(pubs.service.listPublications(ctx.tenant, { status: 'XYZ' }, t), (e) => e.statusCode === 400 && e.code === 'MKT_VALIDATION');
  });
});

test('redes_sociais: o agendamento cria um envio por conexao e o cancelamento do job cancela o envio ainda PENDING', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const item = await env.approvedItem(t, ctx);
    const when = env.inMinutes(60);
    const out = await env.schedule(t, ctx, item.itemId, { channels: ['SITE', 'INSTAGRAM'], when: when.toISOString() });
    const dispatches = () => env.fx.q(t, "SELECT id, status, next_attempt_at, connection_id, idempotency_key FROM integration.dispatches WHERE aggregate_id = :i AND operation = 'publishPost'", { i: item.itemId });
    const rows = await dispatches();
    assert.equal(rows.length, 1, 'só a rede social gera envio (o site não)');
    assert.equal(rows[0].status, 'PENDING');
    assert.equal(new Date(rows[0].next_attempt_at).toISOString(), when.toISOString());
    const insta = out.jobs.find((j) => j.channel === 'INSTAGRAM');
    const [job] = await env.fx.q(t, 'SELECT connection_id FROM marketing.publication_jobs WHERE id = :id', { id: insta.id });
    assert.equal(job.connection_id, rows[0].connection_id);
    await env.schedule(t, ctx, item.itemId, { channels: ['SITE', 'INSTAGRAM'], when: when.toISOString() });
    assert.equal((await dispatches()).length, 1, 'repetir o pedido nao cria segundo envio');
    await cancel(t, insta.id, 'Cancelado no teste da rede social.');
    assert.equal((await dispatches())[0].status, 'CANCELLED');
  });
});
