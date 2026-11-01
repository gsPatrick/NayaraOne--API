'use strict';

// M9-D408 — autopublicação da NAY só para classes autorizadas: nasce PENDING_APPROVAL; com classe ativa e todos os portões verdes vai a APPROVED e SCHEDULED.
// Banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d408.autopublicacao.test.js
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktAutopublish');
const { change } = require('../_helpers/m9d425Env');

let ctx;
before(async () => { ctx = await env.setup(); });
after(async () => { await sequelize.close(); });
afterEach(env.reset);

const inTx = (fn) => env.withRollbackTenantTransaction(ctx.tenant, fn);

test('sem_classe_configurada_nenhum_conteudo_da_nay_e_autopublicado', async () => {
  await inTx(async (t) => {
    env.registerNay();
    const c = await env.soldContent(t, ctx);
    assert.equal(c.status, 'PENDING_APPROVAL');
    assert.equal((await env.jobsOf(t, c.itemId)).length, 0);
    assert.equal((await env.itemOf(t, c.itemId)).approved_by, null);
  });
});

test('classe_nao_autorizada_nunca_autopublica: SOLD_RENTED no INSTAGRAM com classe so para SITE vai a PENDING_APPROVAL', async () => {
  await inTx(async (t) => {
    await env.setClasses(t, ctx.tenant, [env.SOLD_CLASS]);
    env.registerNay();
    const insta = await env.soldContent(t, ctx, { channels: ['INSTAGRAM'] });
    assert.equal(insta.status, 'PENDING_APPROVAL');
    const mixed = await env.soldContent(t, ctx, { channels: ['SITE', 'INSTAGRAM'] });
    assert.equal(mixed.status, 'PENDING_APPROVAL', 'todos os canais pretendidos precisam estar cobertos por classe');
    const noChannel = await env.soldContent(t, ctx, { channels: [] });
    assert.equal(noChannel.status, 'PENDING_APPROVAL', 'sem canal pretendido não há classe que case');
    await env.setClasses(t, ctx.tenant, [{ tipo: 'NEW_PROPERTY', canal: 'SITE' }]);
    assert.equal((await env.soldContent(t, ctx)).status, 'PENDING_APPROVAL', 'outro tipo de conteúdo');
  });
});

test('autopublicacao_so_vale_para_conteudo_da_nay: texto humano na classe autorizada vai a PENDING_APPROVAL', async () => {
  await inTx(async (t) => {
    await env.setClasses(t, ctx.tenant, [env.SOLD_CLASS]);
    const human = await env.soldContent(t, ctx, { human: true });
    assert.equal(human.status, 'PENDING_APPROVAL');
    assert.equal((await env.itemOf(t, human.itemId)).model_name, null);
    env.registerNay();
    assert.equal((await env.soldContent(t, ctx)).status, 'SCHEDULED', 'o mesmo conteúdo escrito pela NAY sai sozinho');
  });
});

test('autopublicacao_nao_ocorre_com_url_em_revisao: URL em revisao (abreviacao, encurtador parecido com abreviacao) vai a PENDING_APPROVAL com motivo proprio', async () => {
  await inTx(async (t) => {
    await env.setClasses(t, ctx.tenant, [env.SOLD_CLASS]);
    for (const text of ['Imóvel vendido no Jardim Europa. Ab.lol/Login', 'Imóvel vendido na Av.Paulista.']) {
      env.registerNay(text);
      const c = await env.soldContent(t, ctx);
      assert.equal(c.status, 'PENDING_APPROVAL', text);
      assert.equal((await env.jobsOf(t, c.itemId)).length, 0);
      assert.equal((await env.itemOf(t, c.itemId)).approved_by, null);
      assert.equal((await env.eventsOf(t, c.itemId)).length, 0);
    }
  });
});

test('autopublica_com_a_classe_ativa: APPROVED por SYSTEM_AUTOPUBLISH, hash gravado, evento autopublished true e job agendado', async () => {
  await inTx(async (t) => {
    await env.setClasses(t, ctx.tenant, [env.SOLD_CLASS]);
    env.registerNay();
    const before = Date.now();
    const c = await env.soldContent(t, ctx);
    assert.equal(c.status, 'SCHEDULED');
    const item = await env.itemOf(t, c.itemId);
    assert.equal(item.approved_by, 'SYSTEM_AUTOPUBLISH:SOLD_RENTED+SITE');
    assert.equal(item.autopublish_class, 'SOLD_RENTED+SITE');
    assert.match(item.approved_hash, /^[0-9a-f]{64}$/);
    const jobs = await env.jobsOf(t, c.itemId);
    assert.deepEqual(jobs.map((j) => [j.channel, j.status]), [['SITE', 'PENDING']]);
    assert.ok(new Date(jobs[0].scheduled_at).getTime() >= before + 15 * 60000, 'respeita a antecedência mínima');
    const [event] = await env.eventsOf(t, c.itemId);
    assert.equal(event.payload_json.payload.autopublished, true);
    assert.equal(event.payload_json.payload.contentId, c.itemId);
  });
});

test('evento_de_aprovacao_indica_autopublished_true e a aprovacao humana indica false', async () => {
  await inTx(async (t) => {
    await env.setClasses(t, ctx.tenant, [env.SOLD_CLASS]);
    env.registerNay();
    const auto = await env.soldContent(t, ctx);
    const manual = await env.soldContent(t, ctx, { human: true });
    await env.service.approve({ tenant: ctx.tenant, actor: ctx.reviewer, itemId: manual.itemId, input: {} }, t);
    assert.equal((await env.eventsOf(t, auto.itemId))[0].payload_json.payload.autopublished, true);
    const human = (await env.eventsOf(t, manual.itemId))[0].payload_json.payload;
    assert.equal(human.autopublished, false);
    assert.equal(human.approvedBy, ctx.reviewer);
  });
});

test('autopublicacao_agenda_com_antecedencia_minima_e_e_idempotente', async () => {
  await inTx(async (t) => {
    await env.setClasses(t, ctx.tenant, [{ ...env.SOLD_CLASS, canais_agendamento: ['SITE', 'PORTAL'], quando: 10 }]);
    env.registerNay();
    const now = new Date('2026-11-09T17:00:30.500Z');
    const c = await env.soldContent(t, ctx, { now });
    assert.equal(c.status, 'SCHEDULED');
    const jobs = await env.jobsOf(t, c.itemId);
    assert.deepEqual(jobs.map((j) => j.channel), ['PORTAL', 'SITE']);
    // agora + 15 min + 10 min de espera = 17:25:30.5, arredondado ao minuto seguinte
    assert.equal(new Date(jobs[0].scheduled_at).toISOString(), '2026-11-09T17:26:00.000Z');
    const again = await env.service.requestApprovalIfRequired({ tenant: ctx.tenant, actor: ctx.tenant.userId, itemId: c.itemId, now }, t);
    assert.equal(again.replay, true);
    assert.equal((await env.jobsOf(t, c.itemId)).length, 2, 'repetir o passo não cria job novo');
    assert.equal((await env.eventsOf(t, c.itemId)).length, 1, 'nem um segundo evento');
  });
});

test('o_minuto_seguinte_vale_mesmo_quando_o_horario_ja_cai_no_minuto_cheio', async () => {
  await inTx(async (t) => {
    await env.setClasses(t, ctx.tenant, [env.SOLD_CLASS]);
    env.registerNay();
    const c = await env.soldContent(t, ctx, { now: new Date('2026-11-09T17:00:00.000Z') });
    const [job] = await env.jobsOf(t, c.itemId);
    assert.equal(new Date(job.scheduled_at).toISOString(), '2026-11-09T17:16:00.000Z');
  });
});

test('autopublicacao_com_kill_switch_ativo_nao_publica: global ou canal ligado leva a PENDING_APPROVAL e nenhum job nasce', async () => {
  await inTx(async (t) => {
    await env.setClasses(t, ctx.tenant, [env.SOLD_CLASS]);
    env.registerNay();
    await change(t, ctx.tenant, { scope: 'CHANNEL', targetId: 'SITE', active: true });
    const byChannel = await env.soldContent(t, ctx);
    assert.equal(byChannel.status, 'PENDING_APPROVAL');
    await change(t, ctx.tenant, { scope: 'CHANNEL', targetId: 'SITE', active: false });
    await change(t, ctx.tenant, { scope: 'GLOBAL', active: true });
    const global = await env.soldContent(t, ctx);
    assert.equal(global.status, 'PENDING_APPROVAL');
    assert.equal((await env.jobsOf(t, global.itemId)).length, 0);
    await change(t, ctx.tenant, { scope: 'GLOBAL', active: false });
    assert.equal((await env.soldContent(t, ctx)).status, 'SCHEDULED', 'ao reativar, volta a autopublicar');
  });
});

test('falha_ao_agendar_depois_de_aprovar_desfaz_a_autopublicacao_e_volta_a_PENDING_APPROVAL', async () => {
  await inTx(async (t) => {
    await env.setClasses(t, ctx.tenant, [env.SOLD_CLASS]);
    env.registerNay();
    const first = await env.soldContent(t, ctx); // a conexão do sandbox já existe (de outro arquivo) ou nasce agora: o teste não presume qual
    assert.equal(first.status, 'SCHEDULED', 'com a conexão do sandbox ativa, a autopublicação agenda');
    await env.fx.q(t, "UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND provider_code = 'site-sandbox' AND status = 'ACTIVE'", { c: ctx.tenant.companyId });
    const second = await env.soldContent(t, ctx);
    assert.equal(second.status, 'PENDING_APPROVAL');
    const item = await env.itemOf(t, second.itemId);
    assert.equal(item.approved_by, null);
    assert.equal(item.approved_hash, null);
    assert.equal((await env.jobsOf(t, second.itemId)).length, 0);
    assert.equal((await env.eventsOf(t, second.itemId)).length, 0, 'nenhum evento de aprovação para o que foi desfeito');
  });
});

test('autopublicacao_em_rede_social_exige_o_parametro_de_publicacao_automatica_das_redes (D239): desligado volta a PENDING_APPROVAL, ligado agenda', async () => {
  await inTx(async (t) => {
    await env.setClasses(t, ctx.tenant, [{ tipo: 'NEW_PROPERTY', canal: 'LINKEDIN' }]);
    const off = await env.newPropertyContent(t, ctx);
    assert.equal(off.status, 'PENDING_APPROVAL', 'o portão social recusa o modo AUTO desligado e o conteúdo espera uma pessoa');
    const [audit] = await env.fx.q(t, "SELECT reason FROM audit.audit_log WHERE entity_id = :i AND action = 'marketing.content.autopublish_reverted'", { i: off.itemId });
    assert.match(audit.reason, /Autopublicação desfeita/);
    assert.equal((await env.eventsOf(t, off.itemId)).length, 0);
    await require('../../../src/features/settings/settings.service').upsertSetting('integration.social.auto_publish_enabled', true, ctx.tenant, ctx.tenant.userId, t);
    const on = await env.newPropertyContent(t, ctx);
    assert.equal(on.status, 'SCHEDULED');
    const rows = await env.fx.q(t, "SELECT status FROM integration.dispatches WHERE aggregate_id = :i AND operation = 'publishPost'", { i: on.itemId });
    assert.deepEqual(rows.map((r) => r.status), ['PENDING']);
  });
});
