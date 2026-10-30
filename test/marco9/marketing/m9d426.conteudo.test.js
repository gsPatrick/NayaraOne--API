'use strict';

// M9-D426 — reel no pipeline do conteúdo: legenda, roteiro e descrição pelo validador factual e pela limpeza de campos públicos, NAY, montagem pela criação,
// revisão e agendamento com a mídia revogada. NAY e validador sempre determinísticos.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktMidia');

let ctx;
before(async () => { ctx = await env.setup(); });
after(async () => { await sequelize.close(); });
afterEach(() => env.reset());

const bodyOf = async (t, itemId) => (await env.fx.q(t, 'SELECT v.body_json FROM marketing.content_versions v JOIN marketing.content_items i ON i.current_version_id = v.id WHERE i.id = :id', { id: itemId }))[0].body_json;
const findings = (out) => out.content.findings.map((f) => f.reason);

test('legenda_passa_pelo_validador_factual', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const prop = await env.fx.seedProperty(t, ctx.tenant, 780000);
    const f = await env.authorizedFile(t, ctx.tenant);
    const base = { midiaId: f.id, sourceEntityType: 'property', sourceEntityId: prop.id };
    const ok = await env.createReel(t, ctx, { ...base, title: 'QA-M9 ok', texto: 'Apartamento de 3 quartos por R$ 780.000.' });
    assert.equal(ok.content.status, 'PENDING_APPROVAL', JSON.stringify(ok.content.findings));
    const price = await env.createReel(t, ctx, { ...base, title: 'QA-M9 preço', texto: 'Apartamento de 3 quartos por R$ 650.000.' });
    assert.equal(price.content.status, 'FACT_CHECK_FAILED', 'preço divergente reprova');
    assert.ok(findings(price).includes('MISMATCH'));
    // só o roteiro cita o preço errado: reprova do mesmo jeito
    const script = await env.createReel(t, ctx, { ...base, title: 'QA-M9 roteiro', texto: 'Apartamento de 3 quartos.', roteiro: 'Cena 1: sala. Fale do preço de R$ 500.000.' });
    assert.equal(script.content.status, 'FACT_CHECK_FAILED', 'o roteiro passa pelo mesmo validador');
    const desc = await env.createReel(t, ctx, { ...base, title: 'QA-M9 descrição', texto: 'Apartamento de 3 quartos.', descricao: 'Imóvel por R$ 1.000.000.' });
    assert.equal(desc.content.status, 'FACT_CHECK_FAILED', 'a descrição também');
  });
});

test('sem_imovel_de_origem_preco_na_legenda_nao_tem_lastro', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const f = await env.authorizedFile(t, ctx.tenant);
    const out = await env.createReel(t, ctx, { midiaId: f.id, title: 'QA-M9 sem fonte', texto: 'Cobertura por R$ 2.000.000.' });
    assert.equal(out.content.status, 'FACT_CHECK_FAILED');
    await env.rejectsCode(env.createReel(t, ctx, { midiaId: f.id, sourceEntityType: 'construction', sourceEntityId: env.fx.uid() }), 400, 'MKT_VALIDATION');
  });
});

test('roteiro_legenda_e_descricao_sao_limpos_de_dado_pessoal', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const f = await env.authorizedFile(t, ctx.tenant);
    const out = await env.createReel(t, ctx, { midiaId: f.id, title: 'QA-M9 limpeza', texto: 'Visite o tour. Fale com o corretor.', roteiro: 'Cena final: escreva para roteiro@exemplo.com.', descricao: 'Contato: corretor@exemplo.com' });
    assert.equal(out.content.status, 'PENDING_APPROVAL', JSON.stringify(out.content.findings));
    const body = await bodyOf(t, out.content.id);
    assert.ok(!/roteiro@exemplo/.test(body.roteiro) && body.roteiro.includes('[REDIGIDO]'), 'e-mail no roteiro redigido');
    assert.ok(!/corretor@exemplo/.test(body.descricao) && body.descricao.includes('[REDIGIDO]'), 'e-mail na descrição redigido');
  });
});

test('nay_escreve_legenda_roteiro_e_descricao_so_com_os_fatos', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const prop = await env.fx.seedProperty(t, ctx.tenant, 780000);
    const f = await env.authorizedFile(t, ctx.tenant);
    const calls = env.fx.registerSandboxNay((facts) => `Texto da NAY com ${facts.quartos} quartos.`);
    const input = { midiaId: f.id, sourceEntityType: 'property', sourceEntityId: prop.id, title: 'QA-M9 NAY' };
    const out = await env.service.createAndRun({ tenant: ctx.tenant, actor: ctx.tenant.userId, input: { type: 'VIDEO_REEL', ...input } }, env.fx.sameTx(t));
    assert.deepEqual(calls.map((c) => c.contentType), ['VIDEO_REEL', 'VIDEO_REEL_ROTEIRO', 'VIDEO_REEL_DESCRICAO']);
    assert.ok(calls.every((c) => c.facts && c.facts.quartos !== undefined && !('midia' in c.facts)), 'a NAY recebe só os fatos');
    const body = await bodyOf(t, out.content.id);
    assert.match(body.texto, /Texto da NAY/);
    assert.match(body.roteiro, /Texto da NAY/);
    assert.match(body.descricao, /Texto da NAY/);
    const [row] = await env.fx.q(t, 'SELECT v.model_name, v.nay_run_id FROM marketing.content_versions v JOIN marketing.content_items i ON i.current_version_id = v.id WHERE i.id = :id', { id: out.content.id });
    assert.equal(row.model_name, 'sandbox-m9d406', 'execução e modelo da NAY registrados');
  });
});

test('montagem_pela_criacao_gera_o_derivado_e_o_reel_chega_a_aprovacao', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const fotos = [];
    for (let i = 0; i < 8; i += 1) fotos.push(await env.authorizedFile(t, ctx.tenant, { mime: 'image/jpeg', name: `foto${i}.jpg` }));
    const montagem = { midias: fotos.map((x) => x.id), formato: 'REEL', proporcao: '9:16', duracaoS: 30, operacoes: [{ op: 'CAPTION', text: 'Tour do apartamento' }] };
    const out = await env.createReel(t, ctx, { montagem, title: 'QA-M9 oito fotos' });
    assert.equal(out.content.status, 'PENDING_APPROVAL');
    const body = await bodyOf(t, out.content.id);
    assert.equal(body.midia.tipo, 'DERIVADO');
    assert.equal(body.midia.duracaoS, 30);
    assert.equal(body.midia.proporcao, '9:16');
    assert.equal(body.midia.derivadoDe.length, 8);
    assert.deepEqual(body.midia.derivadoDe.map((s) => s.sha256), fotos.map((x) => x.sha256));
    assert.equal(body.midiaId, body.midia.derivadoId);
    assert.deepEqual(body.midia.transformLog.operations, [{ op: 'CAPTION', text: 'Tour do apartamento' }], 'transform_log no corpo da versão');
    assert.equal(await env.count(t, 'marketing.media_derivatives'), 1);
    await env.rejectsCode(env.createReel(t, ctx, { montagem, midiaId: fotos[0].id, title: 'QA-M9 os dois' }), 400, 'MKT_VALIDATION');
    await env.rejectsCode(env.createReel(t, ctx, { montagem: { midias: [fotos[0].id], operacoes: [{ op: 'SKY_REPLACE' }] }, title: 'QA-M9 céu' }), 422, 'MKT_MEDIA_MATERIAL_ALTERATION');
  });
});

test('midia_revogada_depois_da_criacao_nao_agenda_nem_revisa', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const f = await env.authorizedFile(t, ctx.tenant);
    const out = await env.createReel(t, ctx, { midiaId: f.id, title: 'QA-M9 revoga', texto: 'Tour pela sala.', channels: ['INSTAGRAM'] });
    const approved = await env.service.approve({ tenant: ctx.tenant, actor: ctx.reviewer, itemId: out.content.id, input: {} }, t);
    assert.equal(approved.status, 'APPROVED');
    await env.video.revokeMedia({ tenant: ctx.tenant, actor: ctx.tenant.userId, fileId: f.id }, t);
    await env.rejectsCode(env.schedule(t, ctx, out.content.id, { channels: ['INSTAGRAM'], when: env.inMinutes(120).toISOString() }), 422, 'MKT_MEDIA_NOT_AUTHORIZED');
    assert.equal(await env.count(t, 'marketing.publication_jobs', 'true'), 0, 'nenhum job foi criado');
  });
});

test('revisao_do_reel_confere_a_midia_de_novo_e_mantem_os_avisos', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const f = await env.authorizedFile(t, ctx.tenant);
    const voice = await env.assemble(t, ctx.tenant, { midias: [f.id], elementosSinteticos: ['VOICE'] });
    const failed = await env.createReel(t, ctx, { midiaId: voice.derivative.id, title: 'QA-M9 revisão', texto: 'Cobertura por R$ 9.000.000.' });
    assert.equal(failed.content.status, 'FACT_CHECK_FAILED');
    const fixed = await env.service.createAndRun({ tenant: ctx.tenant, actor: ctx.tenant.userId, input: { contentItemId: failed.content.id, texto: 'Cobertura com vista para o mar.' } }, env.fx.sameTx(t));
    assert.equal(fixed.content.status, 'PENDING_APPROVAL');
    const body = await bodyOf(t, failed.content.id);
    assert.match(body.texto, /Conteúdo gerado com apoio de inteligência artificial/, 'o aviso volta na versão revisada');
    assert.equal(body.midiaId, voice.derivative.id, 'a mídia viaja de uma versão à outra');
    const failed2 = await env.createReel(t, ctx, { midiaId: voice.derivative.id, title: 'QA-M9 revisão 2', texto: 'Cobertura por R$ 9.000.000.' });
    await env.video.revokeMedia({ tenant: ctx.tenant, actor: ctx.tenant.userId, fileId: f.id }, t);
    await env.rejectsCode(env.service.createAndRun({ tenant: ctx.tenant, actor: ctx.tenant.userId, input: { contentItemId: failed2.content.id, texto: 'Cobertura com vista.' } }, env.fx.sameTx(t)), 422, 'MKT_MEDIA_NOT_AUTHORIZED');
  });
});
