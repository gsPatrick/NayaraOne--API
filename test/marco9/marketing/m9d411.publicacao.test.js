'use strict';

// M9-D411 — worker de publicação: caminho feliz, status real (LIVE, PROCESSING, REJECTED), falhas definitivas e backoff por parâmetro.
// Banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d411.publicacao.test.js
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktWorker');

let ctx;
before(async () => { ctx = await env.setup(); });
after(async () => { await sequelize.close(); });
afterEach(() => { env.reset(); env.resetSandbox(); });

test('publicacao_feliz_grava_externalPostId_url_e_status_live', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['SITE']);
    const out = await env.cycle(t, ctx, { now: s.now });
    assert.equal(out.claimed, 1);
    const job = await env.job(t, s.jobId);
    assert.equal(job.status, 'PUBLISHED');
    assert.equal(job.attempts, 1);
    assert.match(job.external_post_id, /^sbx-site-/);
    assert.match(job.external_url, /^https:\/\/sandbox\.invalid\/site\//, 'o endereço do simulado nunca parece um link real');
    assert.equal(job.provider_status, 'PUBLISHED');
    assert.ok(job.published_at, 'publicado em');
    const [result] = await env.results(t, s.jobId);
    assert.equal(result.outcome, 'SUCCESS');
    assert.equal(result.external_post_id, job.external_post_id);
    assert.equal(result.external_url, job.external_url);
    assert.equal(await env.itemStatus(t, s.itemId), 'PUBLISHED', 'o item fecha pela área de publicações (recomputeItemStatus)');
    const [event] = await env.events(t, s.jobId, 'marketing.publication.completed');
    assert.equal(event.payload_json.payload.externalPostId, job.external_post_id);
    assert.equal(event.payload_json.payload.contentId, s.itemId);
  });
});

test('o_job_sai_pelo_sandbox_do_canal_com_a_chave_do_job_e_marcado_sandbox', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['FACEBOOK']);
    await env.cycle(t, ctx, { now: s.now });
    const job = await env.job(t, s.jobId);
    const { adapters } = require('../../../src/features/marketing/publications');
    assert.equal(adapters.sandboxRecordCount(ctx.tenant.companyId, 'FACEBOOK'), 1, 'um único post no sandbox');
    const adapter = adapters.channelRegistry.get('FACEBOOK', 'SANDBOX').create({ scope: ctx.tenant.companyId });
    const found = await adapter.findByIdempotencyKey(job.idempotency_key);
    assert.equal(found.found, true);
    assert.equal(found.sandbox, true);
    const [result] = await env.results(t, s.jobId);
    assert.equal(result.response_redacted_json.sandbox, true, 'a resposta guardada diz que é simulada');
  });
});

test('provider_status_live_e_rejected', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['SITE']);
    await env.cycle(t, ctx, { now: s.now, scenarios: { SITE: 'REJECTED' } });
    const job = await env.job(t, s.jobId);
    assert.equal(job.status, 'FAILED', 'REJECTED vira FAILED com o motivo');
    assert.equal(job.last_error_code, 'MKT_PROVIDER_REJECTED');
    assert.equal(job.provider_status, 'REJECTED');
    assert.equal(job.attempts, 1, 'sem retry em erro de negócio');
    assert.equal(await env.itemStatus(t, s.itemId), 'FAILED');
    const [event] = await env.events(t, s.jobId, 'marketing.publication.failed');
    assert.equal(event.payload_json.payload.errorCode, 'MKT_PROVIDER_REJECTED');
  });
});

test('post_em_processamento_so_vira_publicado_quando_o_canal_diz_live', async () => {
  let polls = 0; // o adapter é criado de novo a cada resolução: o contador fica fora
  const restore = env.overrideSandbox('INSTAGRAM', (adapter) => {
    const execute = adapter.execute.bind(adapter);
    adapter.execute = async (...args) => ({ ...(await execute(...args)), status: 'PROCESSING' });
    adapter.getStatus = async (ref) => { polls += 1; return { found: true, providerRef: ref, status: polls >= 2 ? 'LIVE' : 'PROCESSING', externalUrl: `https://sandbox.invalid/instagram/${ref}`, sandbox: true }; };
    return adapter;
  });
  try {
    await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
      const s = await env.scheduled(t, ctx, ['INSTAGRAM']);
      await env.cycle(t, ctx, { now: s.now });
      let job = await env.job(t, s.jobId);
      assert.equal(job.status, 'RUNNING', 'aceito pelo canal, ainda não está no ar: não é "Publicado"');
      assert.equal(job.provider_status, 'PROCESSING');
      assert.ok(job.external_post_id);
      assert.equal(await env.itemStatus(t, s.itemId), 'PUBLISHING');
      const list = await require('../../../src/features/marketing/publications').service.listPublications(ctx.tenant, {}, t);
      assert.equal(list.items.find((i) => i.id === s.jobId).displayStatus, 'Em processamento no canal');
      await env.cycle(t, ctx, { now: env.seconds(s.now, 130) });
      job = await env.job(t, s.jobId);
      assert.equal(job.status, 'RUNNING', 'primeira consulta: segue processando');
      await env.cycle(t, ctx, { now: env.seconds(s.now, 300) });
      job = await env.job(t, s.jobId);
      assert.equal(job.status, 'PUBLISHED');
      assert.equal(job.provider_status, 'LIVE');
      assert.equal(await env.itemStatus(t, s.itemId), 'PUBLISHED');
      assert.equal((await env.events(t, s.jobId, 'marketing.publication.completed')).length, 1);
    });
  } finally { restore(); }
});

test('post_processando_que_o_canal_depois_recusa_vira_failed', async () => {
  const restore = env.overrideSandbox('LINKEDIN', (adapter) => {
    const execute = adapter.execute.bind(adapter);
    adapter.execute = async (...args) => ({ ...(await execute(...args)), status: 'PROCESSING' });
    adapter.getStatus = async (ref) => ({ found: true, providerRef: ref, status: 'REJECTED', sandbox: true });
    return adapter;
  });
  try {
    await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
      const s = await env.scheduled(t, ctx, ['LINKEDIN']);
      await env.cycle(t, ctx, { now: s.now });
      await env.cycle(t, ctx, { now: env.seconds(s.now, 130) });
      const job = await env.job(t, s.jobId);
      assert.equal(job.status, 'FAILED');
      assert.equal(job.last_error_code, 'MKT_PROVIDER_REJECTED');
    });
  } finally { restore(); }
});

test('token_revogado_falha_sem_retry_com_mensagem_de_credencial', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['TIKTOK']);
    await env.cycle(t, ctx, { now: s.now, scenarios: { TIKTOK: 'AUTH_REVOKED' } });
    const job = await env.job(t, s.jobId);
    assert.equal(job.status, 'FAILED');
    assert.equal(job.last_error_code, 'MKT_PROVIDER_AUTH_FAILED');
    assert.equal(job.attempts, 1);
    const [result] = await env.results(t, s.jobId);
    assert.equal(result.outcome, 'FAILURE');
  });
});

test('backoff_usa_um_valor_por_retentativa_e_respeita_o_limite_de_tentativas', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['YOUTUBE']);
    const scenarios = { YOUTUBE: 'HTTP_5XX' };
    let now = s.now;
    await env.cycle(t, ctx, { now, scenarios });
    let job = await env.job(t, s.jobId);
    assert.equal(job.status, 'PENDING');
    assert.equal(job.attempts, 1);
    assert.equal(new Date(job.next_attempt_at).getTime(), env.seconds(now, 60).getTime(), 'primeira retentativa: 60 s');
    await env.cycle(t, ctx, { now: env.seconds(now, 59), scenarios });
    assert.equal((await env.job(t, s.jobId)).attempts, 1, 'antes do vencimento nada é enviado');
    now = env.seconds(now, 60);
    await env.cycle(t, ctx, { now, scenarios });
    job = await env.job(t, s.jobId);
    assert.equal(job.attempts, 2);
    assert.equal(new Date(job.next_attempt_at).getTime(), env.seconds(now, 300).getTime(), 'segunda retentativa: 300 s');
    now = env.seconds(now, 300);
    await env.cycle(t, ctx, { now, scenarios });
    job = await env.job(t, s.jobId);
    assert.equal(job.status, 'FAILED', 'três tentativas no total, depois FAILED');
    assert.equal(job.attempts, 3);
    assert.equal(job.last_error_code, 'MKT_PUBLICATION_RETRIES_EXHAUSTED');
  });
});

test('backoff_e_limites_vem_de_parametro_e_lista_curta_repete_o_ultimo', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    await env.setParam(t, ctx, 'marketing.worker.backoff_s', '[10]');
    await env.setParam(t, ctx, 'marketing.worker.max_tentativas', 4);
    const s = await env.scheduled(t, ctx, ['SITE']);
    const scenarios = { SITE: 'HTTP_5XX' };
    let now = s.now;
    for (const expected of [10, 10, 10]) {
      await env.cycle(t, ctx, { now, scenarios });
      const job = await env.job(t, s.jobId);
      assert.equal(new Date(job.next_attempt_at).getTime(), env.seconds(now, expected).getTime());
      now = env.seconds(now, expected);
    }
    await env.cycle(t, ctx, { now, scenarios });
    const job = await env.job(t, s.jobId);
    assert.equal(job.status, 'FAILED');
    assert.equal(job.attempts, 4, 'max_tentativas = 4 no total');
  });
});

test('limite_de_chamadas_429_espera_o_maior_entre_o_backoff_e_o_retry_after', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['SITE']);
    await env.cycle(t, ctx, { now: s.now, scenarios: { SITE: 'HTTP_429' } });
    const job = await env.job(t, s.jobId);
    assert.equal(job.status, 'PENDING');
    assert.equal(new Date(job.next_attempt_at).getTime(), env.seconds(s.now, 60).getTime(), 'Retry-After do sandbox (30 s) é menor que o backoff (60 s)');
  });
});

test('segredo_nao_aparece_no_resultado', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await env.scheduled(t, ctx, ['SITE']);
    await env.cycle(t, ctx, { now: s.now });
    // o gatilho do banco redige segredo mesmo que a camada de cima deixe passar
    await env.fx.q(t, `INSERT INTO marketing.publication_results (group_id, company_id, job_id, attempt_no, outcome, response_redacted_json)
      VALUES (:g, :c, :j, 1, 'FAILURE', CAST(:r AS jsonb))`, { g: ctx.tenant.groupId, c: ctx.tenant.companyId, j: s.jobId, r: JSON.stringify({ access_token: 'segredo-do-provedor', authorization: 'Bearer abc.def.ghi', ok: 'visivel' }) });
    const rows = await env.results(t, s.jobId);
    const text = JSON.stringify(rows);
    assert.ok(!text.includes('segredo-do-provedor') && !text.includes('abc.def.ghi'), 'nenhum segredo no resultado');
    assert.ok(text.includes('visivel'));
    for (const r of rows) assert.ok(!('headers' in r.response_redacted_json), 'o corpo bruto da resposta nunca é guardado');
  });
});
