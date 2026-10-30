'use strict';

// M9-D411 — timeout vira UNKNOWN, reconcile antes de qualquer nova tentativa, UNKNOWN escalado sem republicar, job RUNNING abandonado.
// Banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d411.unknown.test.js
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktWorker');
const { adapters } = require('../../../src/features/marketing/publications');

let ctx;
before(async () => { ctx = await env.setup(); });
after(async () => { await sequelize.close(); });
afterEach(() => { env.reset(); env.resetSandbox(); });

const posts = (channel) => adapters.sandboxRecordCount(ctx.tenant.companyId, channel);
/** Resultados das tentativas e reconciliações (as coletas de métrica têm teste próprio). */
const outcomes = async (t, jobId) => (await env.results(t, jobId)).map((r) => r.outcome).filter((o) => o !== 'METRICS');

test('provider_timeout_nao_duplica_post', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['SITE']);
    let now = s.now;
    // o primeiro envio dá timeout; as tentativas seguintes dariam certo — mas só depois de reconciliar
    for (let i = 0; i < 6; i += 1) {
      await env.cycle(t, ctx, { now, scenarios: { SITE: ['TIMEOUT', 'OK', 'OK'] } });
      now = env.seconds(now, 130);
    }
    const job = await env.job(t, s.jobId);
    assert.equal(job.status, 'PUBLISHED');
    assert.equal(posts('SITE'), 1, 'um único post no canal');
    assert.equal((await outcomes(t, s.jobId)).filter((o) => o === 'SUCCESS' || o === 'RECONCILED_FOUND').length, 1, 'um único resultado de sucesso');
  });
});

test('timeout_marca_unknown_e_nao_faz_retry_cego', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['INSTAGRAM']);
    await env.cycle(t, ctx, { now: s.now, scenarios: { INSTAGRAM: 'UNKNOWN_NOT_PUBLISHED' } });
    const job = await env.job(t, s.jobId);
    assert.equal(job.status, 'UNKNOWN');
    assert.equal(job.attempts, 1, 'nenhuma segunda chamada ao canal');
    assert.ok(job.unknown_since);
    assert.deepEqual(await outcomes(t, s.jobId), ['TIMEOUT']);
    assert.equal(posts('INSTAGRAM'), 0);
    assert.equal(await env.itemStatus(t, s.itemId), 'PUBLISHING');
  });
});

test('timeout_do_adapter_no_prazo_do_parametro_vira_unknown_e_o_reconcile_acha_o_post', async () => {
  const restore = env.overrideSandbox('FACEBOOK', (adapter) => { adapter.slowMs = 2500; return adapter; });
  try {
    await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
      await env.setParam(t, ctx, 'marketing.worker.timeout_s', 1);
      const s = await env.scheduled(t, ctx, ['FACEBOOK']);
      await env.cycle(t, ctx, { now: s.now, scenarios: { FACEBOOK: 'SLOW' } });
      assert.equal((await env.job(t, s.jobId)).status, 'UNKNOWN', 'passou do prazo de 1 s: sem confirmação');
      await new Promise((resolve) => { setTimeout(resolve, 1800); }); // o canal acaba gravando o post depois que o prazo estourou
      await env.cycle(t, ctx, { now: env.seconds(s.now, 5) });
      const job = await env.job(t, s.jobId);
      assert.equal(job.status, 'PUBLISHED');
      assert.equal(posts('FACEBOOK'), 1, 'sem segundo post');
    });
  } finally { restore(); }
});

test('reconcile_encontrou_marca_publicado', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['INSTAGRAM']);
    await env.cycle(t, ctx, { now: s.now, scenarios: { INSTAGRAM: 'UNKNOWN_BUT_PUBLISHED' } });
    assert.equal((await env.job(t, s.jobId)).status, 'UNKNOWN');
    await env.cycle(t, ctx, { now: env.seconds(s.now, 30) });
    const job = await env.job(t, s.jobId);
    assert.equal(job.status, 'PUBLISHED');
    assert.equal(job.attempts, 1, 'nenhuma nova tentativa de envio');
    assert.match(job.external_post_id, /^sbx-instagram-/);
    assert.equal(job.unknown_since, null);
    assert.deepEqual(await outcomes(t, s.jobId), ['TIMEOUT', 'RECONCILED_FOUND']);
    assert.equal(posts('INSTAGRAM'), 1, 'um único post (linha do tempo da evidência)');
    assert.equal(await env.itemStatus(t, s.itemId), 'PUBLISHED');
  });
});

test('reconcile_nao_encontrou_volta_a_pending', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['INSTAGRAM']);
    await env.cycle(t, ctx, { now: s.now, scenarios: { INSTAGRAM: 'UNKNOWN_NOT_PUBLISHED' } });
    const at = env.seconds(s.now, 30);
    await env.cycle(t, ctx, { now: at });
    let job = await env.job(t, s.jobId);
    assert.equal(job.status, 'PENDING', 'ausência confirmada: só então volta a PENDING');
    assert.equal(job.attempts, 1, 'a tentativa que deu timeout conta; a seguinte será a 2');
    assert.equal(new Date(job.next_attempt_at).getTime(), env.seconds(at, 60).getTime(), 'espera da primeira retentativa');
    assert.deepEqual(await outcomes(t, s.jobId), ['TIMEOUT', 'RECONCILED_NOT_FOUND']);
    await env.cycle(t, ctx, { now: env.seconds(at, 61) });
    job = await env.job(t, s.jobId);
    assert.equal(job.status, 'PUBLISHED');
    assert.equal(job.attempts, 2);
    assert.equal(posts('INSTAGRAM'), 1);
  });
});

test('reconcile_sem_tentativas_restantes_falha_sem_republicar', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    await env.setParam(t, ctx, 'marketing.worker.max_tentativas', 1);
    const s = await env.scheduled(t, ctx, ['TIKTOK']);
    await env.cycle(t, ctx, { now: s.now, scenarios: { TIKTOK: 'UNKNOWN_NOT_PUBLISHED' } });
    await env.cycle(t, ctx, { now: env.seconds(s.now, 30) });
    const job = await env.job(t, s.jobId);
    assert.equal(job.status, 'FAILED');
    assert.equal(job.last_error_code, 'MKT_PUBLICATION_RETRIES_EXHAUSTED');
    assert.equal(posts('TIKTOK'), 0);
  });
});

test('reconcile_que_falha_continua_unknown_e_tenta_de_novo_no_intervalo', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['INSTAGRAM']);
    await env.cycle(t, ctx, { now: s.now, scenarios: { INSTAGRAM: 'UNKNOWN_BUT_PUBLISHED' } });
    const sandbox = adapters.channelRegistry.get('INSTAGRAM', 'SANDBOX').create({ scope: ctx.tenant.companyId });
    await sandbox.revoke(); // a consulta ao canal passa a falhar (credencial revogada)
    const at = env.seconds(s.now, 30);
    await env.cycle(t, ctx, { now: at });
    let job = await env.job(t, s.jobId);
    assert.equal(job.status, 'UNKNOWN', 'reconcile falhou: permanece UNKNOWN');
    assert.equal(new Date(job.next_check_at).getTime(), env.seconds(at, 120).getTime(), 'próxima reconciliação em reconcile_s');
    const calls = (await outcomes(t, s.jobId)).length;
    await env.cycle(t, ctx, { now: env.seconds(at, 60) });
    assert.equal((await outcomes(t, s.jobId)).length, calls, 'antes do intervalo nada é tentado');
    assert.equal((await env.job(t, s.jobId)).attempts, 1);
  });
});

test('unknown_por_24h_escala_sem_republicar', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['INSTAGRAM']);
    await env.cycle(t, ctx, { now: s.now, scenarios: { INSTAGRAM: 'UNKNOWN_BUT_PUBLISHED' } });
    const sandbox = adapters.channelRegistry.get('INSTAGRAM', 'SANDBOX').create({ scope: ctx.tenant.companyId });
    await sandbox.revoke();
    await env.cycle(t, ctx, { now: new Date(s.now.getTime() + 23 * env.HOUR) });
    assert.equal((await env.job(t, s.jobId)).escalated_at, null, 'antes de 24 h não escala');
    await env.cycle(t, ctx, { now: new Date(s.now.getTime() + 25 * env.HOUR) });
    const job = await env.job(t, s.jobId);
    assert.equal(job.status, 'UNKNOWN', 'nunca republica sozinho');
    assert.equal(job.last_error_code, 'MKT_PUBLICATION_UNKNOWN_ESCALATED');
    assert.ok(job.escalated_at);
    assert.equal(job.attempts, 1);
    const audit = await env.fx.q(t, "SELECT reason FROM audit.audit_log WHERE entity_id = :id AND action = 'marketing.publication.unknown_escalated'", { id: s.jobId });
    assert.equal(audit.length, 1);
    const notes = await env.fx.q(t, "SELECT title, user_id FROM core.notifications WHERE user_id = :u AND title LIKE 'Publicação sem confirmação%'", { u: job.created_by });
    assert.equal(notes.length, 1, 'notifica quem agendou');
    await env.cycle(t, ctx, { now: new Date(s.now.getTime() + 26 * env.HOUR) });
    const again = await env.fx.q(t, "SELECT 1 FROM audit.audit_log WHERE entity_id = :id AND action = 'marketing.publication.unknown_escalated'", { id: s.jobId });
    assert.equal(again.length, 1, 'o alerta sai uma vez só');
    // a decisão humana: cancelar o job escalado (POST /marketing/publications/:id/cancel) e agendar de novo com chave nova
    const cancelled = await require('../../../src/features/marketing/publications').service.cancelJob({ tenant: ctx.tenant, actor: ctx.reviewer, jobId: s.jobId, reason: 'QA-M9 decisão humana' }, t);
    assert.equal(cancelled.status, 'CANCELLED');
  });
});

test('unknown_sem_escalar_continua_nao_cancelavel_antes_da_reconciliacao', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['INSTAGRAM']);
    await env.cycle(t, ctx, { now: s.now, scenarios: { INSTAGRAM: 'UNKNOWN_BUT_PUBLISHED' } });
    await env.rejectsCode(require('../../../src/features/marketing/publications').service.cancelJob({ tenant: ctx.tenant, actor: ctx.reviewer, jobId: s.jobId }, t), 409, 'MKT_JOB_NOT_CANCELLABLE');
  });
});

test('processo_cai_com_job_running', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['INSTAGRAM']);
    // o processo caiu depois de gravar RUNNING e depois de o canal receber o post
    await env.fx.q(t, "UPDATE marketing.publication_jobs SET status = 'RUNNING', attempts = 1, started_at = :at WHERE id = :id", { at: s.now, id: s.jobId });
    const sandbox = adapters.channelRegistry.get('INSTAGRAM', 'SANDBOX').create({ scope: ctx.tenant.companyId });
    await sandbox.publish({ texto: 'x' }, { idempotencyKey: (await env.job(t, s.jobId)).idempotency_key });
    await env.cycle(t, ctx, { now: env.seconds(s.now, 59) });
    assert.equal((await env.job(t, s.jobId)).status, 'RUNNING', 'antes de 2 x o prazo do adapter (60 s) ainda é considerado em andamento');
    await env.cycle(t, ctx, { now: env.seconds(s.now, 61) });
    const job = await env.job(t, s.jobId);
    assert.equal(job.attempts, 1, 'nenhuma nova chamada de envio');
    const rows = await env.results(t, s.jobId);
    assert.equal(rows[0].outcome, 'TIMEOUT', 'passou de 2 x 30 s: tratado como timeout, nunca retry direto');
    assert.equal(rows[0].response_redacted_json.reason, 'RUNNING_ABANDONED');
    assert.equal(rows[1].outcome, 'RECONCILED_FOUND', 'reconcile antes de qualquer nova tentativa: achou o post que o canal já tinha');
    assert.equal(job.status, 'PUBLISHED');
    assert.equal(posts('INSTAGRAM'), 1, 'sem segundo post');
  });
});

test('o_prazo_do_job_abandonado_acompanha_o_parametro_do_adapter', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    await env.setParam(t, ctx, 'marketing.worker.timeout_s', 100);
    const s = await env.scheduled(t, ctx, ['SITE']);
    await env.fx.q(t, "UPDATE marketing.publication_jobs SET status = 'RUNNING', attempts = 1, started_at = :at WHERE id = :id", { at: s.now, id: s.jobId });
    await env.cycle(t, ctx, { now: env.seconds(s.now, 150) });
    assert.equal((await env.job(t, s.jobId)).status, 'RUNNING', '150 s < 2 x 100 s');
    await env.cycle(t, ctx, { now: env.seconds(s.now, 201) });
    assert.notEqual((await env.job(t, s.jobId)).status, 'RUNNING');
  });
});
