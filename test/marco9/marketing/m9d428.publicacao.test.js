'use strict';

// M9-D428 — as redes no pipeline de publicação: isolamento de falha por rede no worker, status real (PROCESSING até o canal dizer LIVE), reautorização
// da conexão e rede indisponível. Banco descartável, role de runtime.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktWorker');
const midia = require('../_helpers/mktMidia');

let ctx;
before(async () => { ctx = await env.setup(); });
after(async () => { await sequelize.close(); });
afterEach(() => { env.reset(); env.resetSandbox(); });

const { fx } = env;

/** Reel 9:16 de 30 s aprovado e agendado nas redes pedidas; `now` do worker = 1 min depois do horário. */
async function scheduledReel(t, channels) {
  const file = await midia.authorizedFile(t, ctx.tenant, { mime: 'video/mp4' });
  const out = await midia.createReel(t, ctx, { montagem: { midias: [file.id], formato: 'REEL', proporcao: '9:16', duracaoS: 30 }, title: 'QA-M9 rede', channels });
  assert.equal(out.content.status, 'PENDING_APPROVAL', JSON.stringify(out.content.findings));
  await env.service.approve({ tenant: ctx.tenant, actor: ctx.reviewer, itemId: out.content.id, input: {} }, t);
  const when = env.inMinutes(120);
  const scheduled = await env.schedule(t, ctx, out.content.id, { channels, when: when.toISOString() });
  return { itemId: out.content.id, jobs: scheduled.jobs, now: new Date(when.getTime() + 60000) };
}
const byChannel = (s, channel) => s.jobs.find((j) => j.channel === channel).id;

test('falha_em_uma_rede_nao_bloqueia_outras: o LinkedIn cai, o Instagram publica e o Facebook segue', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await scheduledReel(t, ['INSTAGRAM', 'LINKEDIN', 'FACEBOOK']);
    await env.cycle(t, ctx, { now: s.now, scenarios: { LINKEDIN: 'HTTP_5XX' } });
    assert.equal((await env.job(t, byChannel(s, 'INSTAGRAM'))).status, 'RUNNING', 'vídeo no Instagram: ainda em processamento');
    const li = await env.job(t, byChannel(s, 'LINKEDIN'));
    assert.deepEqual([li.status, li.last_error_code], ['PENDING', 'MKT_PROVIDER_UNAVAILABLE'], 'rede fora do ar: nova tentativa com segurança');
    assert.equal((await env.job(t, byChannel(s, 'FACEBOOK'))).status, 'RUNNING');
    assert.ok(li.next_attempt_at, 'a nova tentativa tem horário');
  });
});

test('status_real_live_so_apos_confirmacao: PROCESSING nao e publicado, LIVE e', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await scheduledReel(t, ['INSTAGRAM']);
    const jobId = byChannel(s, 'INSTAGRAM');
    await env.cycle(t, ctx, { now: s.now });
    let job = await env.job(t, jobId);
    assert.deepEqual([job.status, job.provider_status], ['RUNNING', 'PROCESSING']);
    assert.ok(job.external_post_id, 'o post já existe no canal, mas não está no ar');
    assert.notEqual(await env.itemStatus(t, s.itemId), 'PUBLISHED', '"Publicado" só com o canal dizendo LIVE');
    await env.cycle(t, ctx, { now: env.seconds(s.now, 300) });
    job = await env.job(t, jobId);
    assert.deepEqual([job.status, job.provider_status], ['PUBLISHED', 'LIVE']);
    assert.match(job.external_url, /^https:\/\/sandbox\.invalid\/instagram\//);
    assert.equal(await env.itemStatus(t, s.itemId), 'PUBLISHED');
    const results = await env.results(t, jobId);
    assert.ok(results.some((r) => r.provider_status === 'LIVE'), 'o status real fica gravado');
    assert.equal(require('../../../src/features/marketing/publications').adapters.sandboxRecordCount(ctx.tenant.companyId, 'INSTAGRAM'), 1);
  });
});

test('token_expirado_marca_a_rede_como_precisando_de_reautorizacao_sem_parar_as_outras', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await scheduledReel(t, ['TIKTOK', 'LINKEDIN']);
    await env.cycle(t, ctx, { now: s.now, scenarios: { TIKTOK: 'AUTH_REVOKED' } });
    const tiktok = await env.job(t, byChannel(s, 'TIKTOK'));
    assert.deepEqual([tiktok.status, tiktok.last_error_code], ['FAILED', 'MKT_PROVIDER_AUTH_FAILED']);
    assert.equal((await env.job(t, byChannel(s, 'LINKEDIN'))).status, 'RUNNING', 'a outra rede não é afetada');
    const [conn] = await fx.q(t, 'SELECT status FROM integration.connections WHERE id = :id', { id: tiktok.connection_id });
    assert.equal(conn.status, 'ACTIVE', 'a conexão da família é compartilhada: pausá-la pararia as outras redes');
    // na vida real a falha e a criação da conexão são transações diferentes; aqui tudo é uma transação só (now() fixo), então a falha é marcada como posterior à conexão
    await fx.q(t, "UPDATE marketing.publication_jobs SET updated_at = clock_timestamp() + interval '1 second' WHERE id = :id", { id: tiktok.id });
    await assert.rejects(scheduledReelOnly(t, ['TIKTOK']), (e) => e.statusCode === 409 && e.code === 'MKT_PROVIDER_AUTH_FAILED' && /reautorizada/.test(e.message) && e.details.state === 'NEEDS_REAUTH' && e.details.channel === 'TIKTOK');
    assert.equal((await scheduledReelOnly(t, ['LINKEDIN'])).jobs.length, 1, 'a outra rede continua agendando');
    // reautorizar (conexão atualizada pelo administrador) limpa o estado da rede
    await fx.q(t, "UPDATE integration.connections SET updated_at = clock_timestamp() + interval '1 minute' WHERE id = :id", { id: tiktok.connection_id });
    env.resetSandbox();
    assert.equal((await scheduledReelOnly(t, ['TIKTOK'])).jobs.length, 1);
  });
});

/** Segundo agendamento na mesma empresa, devolvido como promessa para o teste conferir a recusa. */
async function scheduledReelOnly(t, channels) {
  const file = await midia.authorizedFile(t, ctx.tenant, { mime: 'video/mp4' });
  const out = await midia.createReel(t, ctx, { montagem: { midias: [file.id], formato: 'REEL', proporcao: '9:16', duracaoS: 20 }, title: 'QA-M9 rede 2', channels });
  await env.service.approve({ tenant: ctx.tenant, actor: ctx.reviewer, itemId: out.content.id, input: {} }, t);
  return env.schedule(t, ctx, out.content.id, { channels, when: env.inMinutes(180).toISOString() });
}

test('o_resultado_gravado_pelo_worker_nao_traz_segredo_nem_o_texto_da_marca', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await scheduledReel(t, ['FACEBOOK']);
    await env.cycle(t, ctx, { now: s.now });
    const results = await env.results(t, byChannel(s, 'FACEBOOK'));
    const dump = JSON.stringify(results);
    assert.ok(!/[\u200b\u200c]/.test(dump), 'a marca invisível não é gravada no resultado');
    assert.ok(results.every((r) => r.response_redacted_json && r.response_redacted_json.sandbox === true));
  });
});

test('token_so_no_cofre: conexao de rede com token na configuracao e recusada e so a referencia do cofre vale', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const registry = require('../../../src/features/integrations/registry/registry.service');
    const who = { groupId: ctx.tenant.groupId, companyId: ctx.tenant.companyId, userId: ctx.tenant.userId };
    const TOKEN = 'EAABsbCS1iHgBAPlmnopQRSTuvwxYZ0123456789tokenDaRede';
    await assert.rejects(registry.createConnection({ providerCode: 'social-sandbox', environment: 'SANDBOX', label: 'QA-M9 rede token', configJson: { accessToken: TOKEN } }, who, t),
      (e) => e.statusCode === 422 && e.code === 'INTEGRATION_SECRET_IN_CONFIG');
    await assert.rejects(registry.createConnection({ providerCode: 'social-sandbox', environment: 'SANDBOX', label: 'QA-M9 rede token 2', secretRef: TOKEN }, who, t),
      (e) => e.statusCode >= 400 && e.statusCode < 500, 'o token no lugar da referência do cofre também é recusado');
    const rows = await fx.q(t, 'SELECT config_json, secret_ref FROM integration.connections WHERE company_id = :c', { c: ctx.tenant.companyId });
    assert.ok(!JSON.stringify(rows).includes(TOKEN), 'nenhuma linha guarda o token');
    const results = await fx.q(t, 'SELECT response_redacted_json FROM marketing.publication_results WHERE company_id = :c', { c: ctx.tenant.companyId });
    assert.ok(!JSON.stringify(results).includes(TOKEN));
  });
});
