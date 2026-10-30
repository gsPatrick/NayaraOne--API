'use strict';

// M9-D426 — conteúdo sintético: marca, aviso padrão na legenda, política por parâmetro e "Imagem ilustrativa" nas renderizações de projeto de obra.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktMidia');

let ctx;
before(async () => { ctx = await env.setup(); });
after(async () => { await sequelize.close(); });

const AI = 'Conteúdo gerado com apoio de inteligência artificial';
const bodyOf = async (t, itemId) => (await env.fx.q(t, 'SELECT v.body_json, v.id FROM marketing.content_versions v JOIN marketing.content_items i ON i.current_version_id = v.id WHERE i.id = :id', { id: itemId }))[0];

test('conteudo_sintetico_exige_aviso', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const f = await env.authorizedFile(t, ctx.tenant);
    const { derivative } = await env.assemble(t, ctx.tenant, { midias: [f.id], elementosSinteticos: [{ kind: 'VOICE' }] });
    assert.equal(derivative.synthetic, true, 'voz sintética marca synthetic = true');
    assert.deepEqual(derivative.synthetic_kinds, ['VOICE']);
    const plain = await env.assemble(t, ctx.tenant, { midias: [f.id] });
    assert.equal(plain.derivative.synthetic, false, 'sem elemento sintético o aviso não é exigido');

    const out = await env.createReel(t, ctx, { midiaId: derivative.id, title: 'QA-M9 voz', texto: 'Tour guiado pelo apartamento.' });
    const body = (await bodyOf(t, out.content.id)).body_json;
    assert.ok(body.texto.includes(AI), 'o texto recebe o aviso padrão');
    assert.equal(body.midia.sintetico, true);
    assert.deepEqual(body.midia.tiposSinteticos, ['VOICE']);
    const noNotice = await env.createReel(t, ctx, { midiaId: plain.derivative.id, title: 'QA-M9 sem aviso', texto: 'Tour guiado pelo apartamento.' });
    assert.ok(!(await bodyOf(t, noNotice.content.id)).body_json.texto.includes(AI));

    // quem tira o aviso por fora (versão nova sem ele) não passa pela conformidade
    const item = await env.fx.q(t, 'SELECT * FROM marketing.content_items WHERE id = :id', { id: out.content.id });
    const version = (await env.fx.q(t, 'SELECT * FROM marketing.content_versions WHERE id = :id', { id: item[0].current_version_id }))[0];
    const repo = require('../../../src/features/marketing/content/pipeline.repository');
    await repo.insertNextVersion(ctx.tenant, ctx.tenant.userId, version, { body: { ...version.body_json, texto: 'Tour guiado pelo apartamento.' }, contentHash: env.sha(`${version.id}-sem-aviso`) }, t);
    await repo.setStatus(item[0].id, 'BRANDED', ctx.tenant.userId, t);
    const latest = (await env.fx.q(t, 'SELECT current_version_id FROM marketing.content_items WHERE id = :id', { id: item[0].id }))[0].current_version_id;
    await repo.writeCheck(latest, 'branding', { ok: true, at: new Date().toISOString(), detalhes: {} }, null, t);
    await assert.rejects(env.service.applyCompliance({ tenant: ctx.tenant, actor: ctx.tenant.userId, itemId: item[0].id }, t),
      (e) => e.statusCode === 422 && e.code === 'MKT_SYNTHETIC_DISCLOSURE_REQUIRED' && /aviso de transparência/.test(e.message) && e.details.missing.includes(AI));
  });
});

test('politica_de_transparencia_e_textos_vem_dos_parametros', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const f = await env.authorizedFile(t, ctx.tenant);
    const voice = await env.assemble(t, ctx.tenant, { midias: [f.id], elementosSinteticos: ['VOICE'] });
    await env.setParam(t, ctx.tenant, 'marketing.video.politica_transparencia', 'POR_TIPO');
    await env.setParam(t, ctx.tenant, 'marketing.video.tipos_com_aviso', 'RENDER,AVATAR');
    const out = await env.createReel(t, ctx, { midiaId: voice.derivative.id, title: 'QA-M9 por tipo', texto: 'Tour pela sala.' });
    assert.ok(!(await bodyOf(t, out.content.id)).body_json.texto.includes(AI), 'voz fora da lista de tipos: sem aviso na política POR_TIPO');
    await env.setParam(t, ctx.tenant, 'marketing.video.tipos_com_aviso', 'VOICE');
    await env.setParam(t, ctx.tenant, 'marketing.video.aviso_ia', 'Narração feita por inteligência artificial');
    const out2 = await env.createReel(t, ctx, { midiaId: voice.derivative.id, title: 'QA-M9 texto novo', texto: 'Tour pela sala.' });
    assert.match((await bodyOf(t, out2.content.id)).body_json.texto, /Narração feita por inteligência artificial/);
    await assert.rejects(env.setParam(t, ctx.tenant, 'marketing.video.politica_transparencia', 'NUNCA'), (e) => e.code === 'MKT_PARAM_INVALID');
    await assert.rejects(env.setParam(t, ctx.tenant, 'marketing.video.tipos_com_aviso', 'HOLOGRAMA'), (e) => e.code === 'MKT_PARAM_INVALID');
  });
});

test('renderizacao_de_projeto_exige_imagem_ilustrativa', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const render = await env.authorizedFile(t, ctx.tenant, { mime: 'image/png', name: 'projeto.png', origin: 'RENDER_PROJETO' });
    await assert.rejects(env.assemble(t, ctx.tenant, { midias: [render.id], operacoes: [{ op: 'CAPTION', text: 'Residencial Aurora' }] }),
      (e) => e.statusCode === 422 && e.code === 'MKT_SYNTHETIC_DISCLOSURE_REQUIRED' && e.details.reason === 'ILLUSTRATIVE_PHRASE_MISSING' && e.details.required === 'Imagem ilustrativa');
    await env.rejectsCode(env.assemble(t, ctx.tenant, { midias: [render.id] }), 422, 'MKT_SYNTHETIC_DISCLOSURE_REQUIRED');
    const ok = await env.assemble(t, ctx.tenant, { midias: [render.id], operacoes: [{ op: 'CAPTION', text: 'IMAGEM ILUSTRATIVA — Residencial Aurora' }] });
    assert.equal(ok.derivative.synthetic, true, 'renderização de projeto é sintética');
    assert.deepEqual(ok.derivative.synthetic_kinds, ['RENDER']);
    const out = await env.createReel(t, ctx, { midiaId: ok.derivative.id, title: 'QA-M9 obra', texto: 'Lançamento do residencial.' });
    assert.match((await bodyOf(t, out.content.id)).body_json.texto, /Imagens ilustrativas de projeto/, 'aviso padrão de projeto na legenda');
    // mídia de projeto usada direto (sem montagem): a expressão precisa estar no texto
    await env.rejectsCode(env.createReel(t, ctx, { midiaId: render.id, title: 'QA-M9 obra direta', texto: 'Lançamento do residencial.' }), 422, 'MKT_SYNTHETIC_DISCLOSURE_REQUIRED');
    const direct = await env.createReel(t, ctx, { midiaId: render.id, title: 'QA-M9 obra direta ok', texto: 'Imagem ilustrativa do residencial.' });
    assert.match((await bodyOf(t, direct.content.id)).body_json.texto, /Imagem ilustrativa do residencial\./);
    await env.setParam(t, ctx.tenant, 'marketing.video.texto_ilustrativa', 'Imagem meramente ilustrativa');
    await env.rejectsCode(env.assemble(t, ctx.tenant, { midias: [render.id], operacoes: [{ op: 'CAPTION', text: 'Imagem ilustrativa' }] }), 422, 'MKT_SYNTHETIC_DISCLOSURE_REQUIRED');
  });
});
