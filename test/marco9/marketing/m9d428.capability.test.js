'use strict';

// M9-D428 — capabilities por rede: o conteúdo é conferido contra o limite da rede ANTES de criar o job (422 MKT_CAPABILITY_VIOLATION com o limite violado).
// Banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d428.capability.test.js
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktMidia');
const social = require('../../../src/features/marketing/publications/adapters/social');

let ctx;
before(async () => { ctx = await env.setup(); });
after(async () => { await sequelize.close(); });
afterEach(() => env.reset());

const when = () => env.inMinutes(120).toISOString();
const jobs = (t) => env.count(t, 'marketing.publication_jobs');

/** Reel aprovado a partir de uma mídia autorizada com as medidas informadas; devolve o id do item. */
async function approvedReel(t, { dims, mime = 'video/mp4', texto = 'Tour pelo apartamento.', montagem, origin } = {}) {
  const file = await env.authorizedFile(t, ctx.tenant, { mime, name: mime.startsWith('image') ? 'foto.png' : 'tour.mp4', dims, origin });
  const input = montagem ? { montagem: { midias: [file.id], ...montagem } } : { midiaId: file.id };
  const out = await env.createReel(t, ctx, { ...input, texto, title: `QA-M9 cap ${Math.random()}` });
  assert.equal(out.content.status, 'PENDING_APPROVAL', JSON.stringify(out.content.findings));
  await env.service.approve({ tenant: ctx.tenant, actor: ctx.reviewer, itemId: out.content.id, input: {} }, t);
  return out.content.id;
}

const violation = (channel, limit) => (e) => e.statusCode === 422 && e.code === 'MKT_CAPABILITY_VIOLATION' && /limite da rede/.test(e.message) && e.details.channel === channel && e.details.limit === limit;

test('capability_bloqueia_antes_de_agendar', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    // reel 16:9: o LinkedIn aceita, o Instagram não (reel é 9:16): 422 e nenhum job, nem o do LinkedIn que faria parte do mesmo pedido
    const wide = await approvedReel(t, { montagem: { formato: 'REEL', proporcao: '16:9', duracaoS: 30 } });
    await assert.rejects(env.schedule(t, ctx, wide, { channels: ['LINKEDIN', 'INSTAGRAM'], when: when() }), violation('INSTAGRAM', 'ASPECT_RATIO'));
    assert.equal(await jobs(t), 0, 'a violação de uma rede impede o agendamento de todas');
    // imagem 3:1 no Instagram: 422
    const strip = await approvedReel(t, { mime: 'image/png', dims: { width: 3000, height: 1000 } });
    await assert.rejects(env.schedule(t, ctx, strip, { channels: ['INSTAGRAM'], when: when() }), (e) => violation('INSTAGRAM', 'ASPECT_RATIO')(e) && e.details.actual === '3:1');
    // reel 9:16 de 30 s no Instagram: aceito
    const reel = await approvedReel(t, { montagem: { formato: 'REEL', proporcao: '9:16', duracaoS: 30 } });
    const ok = await env.schedule(t, ctx, reel, { channels: ['INSTAGRAM'], when: when() });
    assert.equal(ok.jobs.length, 1);
    // o mesmo reel fora do tamanho de duração do reel do Instagram
    const longReel = await approvedReel(t, { montagem: { formato: 'REEL', proporcao: '9:16', duracaoS: 600 } });
    await assert.rejects(env.schedule(t, ctx, longReel, { channels: ['INSTAGRAM'], when: when() }), (e) => violation('INSTAGRAM', 'DURATION_MAX')(e) && e.details.max === 90 && e.details.actual === 600);
    assert.equal(await jobs(t), 1, 'só o job do reel válido');
  });
});

test('imagem_1_91_para_1_vai_ao_linkedin_e_tres_para_um_nao_vai_ao_instagram', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const item = await approvedReel(t, { mime: 'image/png', dims: { width: 1200, height: 628 } });
    assert.equal((await env.schedule(t, ctx, item, { channels: ['LINKEDIN'], when: when() })).jobs.length, 1, 'LinkedIn aceita 1,91:1');
    const wide = await approvedReel(t, { mime: 'image/png', dims: { width: 3000, height: 1000 } });
    await assert.rejects(env.schedule(t, ctx, wide, { channels: ['INSTAGRAM'], when: when() }), violation('INSTAGRAM', 'ASPECT_RATIO'));
    await assert.rejects(env.schedule(t, ctx, wide, { channels: ['LINKEDIN'], when: when() }), violation('LINKEDIN', 'ASPECT_RATIO'));
  });
});

test('legenda_acima_do_limite_da_rede_e_recusada_com_o_limite_e_o_tamanho', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const big = await approvedReel(t, { montagem: { formato: 'REEL', proporcao: '9:16', duracaoS: 30 }, texto: `Tour. ${'Sala ampla e clara. '.repeat(120)}` });
    await assert.rejects(env.schedule(t, ctx, big, { channels: ['INSTAGRAM'], when: when() }),
      (e) => violation('INSTAGRAM', 'CAPTION_MAX')(e) && e.details.max === 2200 && e.details.actual > 2200 - 40);
    // a mesma legenda cabe no LinkedIn (limite maior): o limite é por rede
    assert.equal((await env.schedule(t, ctx, big, { channels: ['LINKEDIN'], when: when() })).jobs.length, 1);
  });
});

test('limites_vem_do_parametro_da_rede_e_a_marca_de_idempotencia_entra_na_conta', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const item = await approvedReel(t, { montagem: { formato: 'REEL', proporcao: '9:16', duracaoS: 30 }, texto: 'a'.repeat(2190) });
    await assert.rejects(env.schedule(t, ctx, item, { channels: ['INSTAGRAM'], when: when() }), violation('INSTAGRAM', 'CAPTION_MAX'), 'a marca do post também ocupa a legenda');
    const caps = { ...social.DEFAULT_CAPABILITIES.INSTAGRAM, legendaMax: 5000 };
    await env.setParam(t, ctx.tenant, 'marketing.social.instagram.capacidades', JSON.stringify(caps));
    assert.equal((await env.schedule(t, ctx, item, { channels: ['INSTAGRAM'], when: when() })).jobs.length, 1, 'limite novo pelo parâmetro');
    await assert.rejects(env.setParam(t, ctx.tenant, 'marketing.social.instagram.capacidades', '{"legendaMax":0}'), (e) => e.code === 'MKT_PARAM_INVALID');
    await assert.rejects(env.setParam(t, ctx.tenant, 'marketing.social.tiktok.capacidades', 'não é json'), (e) => e.code === 'MKT_PARAM_INVALID');
    await assert.rejects(env.setParam(t, ctx.tenant, 'marketing.social.marca_idempotencia', 'TATUAGEM'), (e) => e.code === 'MKT_PARAM_INVALID');
  });
});

test('as_capabilities_de_cada_rede_sao_as_do_livro_e_do_provedor', () => {
  const ig = social.DEFAULT_CAPABILITIES.INSTAGRAM;
  assert.equal(ig.legendaMax, 2200);
  assert.deepEqual(ig.proporcoes.REEL, ['9:16']);
  assert.ok(['1:1', '4:5'].every((r) => ig.proporcoes.IMAGE.includes(r)));
  assert.ok(!ig.proporcoes.IMAGE.includes('3:1'));
  for (const network of social.SOCIAL_NETWORKS) {
    const caps = social.DEFAULT_CAPABILITIES[network];
    assert.ok(caps.formatos.every((f) => ['IMAGE', 'CAROUSEL', 'VIDEO', 'REEL'].includes(f)), network);
    assert.ok(caps.legendaMax > 0 && Object.keys(caps.proporcoes).length > 0, network);
  }
  assert.ok(social.DEFAULT_CAPABILITIES.LINKEDIN.proporcoes.IMAGE.includes('1.91:1'));
  assert.ok(!social.DEFAULT_CAPABILITIES.LINKEDIN.formatos.includes('REEL'));
  assert.deepEqual(social.SOCIAL_NETWORKS, ['INSTAGRAM', 'FACEBOOK', 'LINKEDIN', 'YOUTUBE', 'TIKTOK']);
});

test('conteudo_sem_midia_so_confere_a_legenda', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const small = await env.pendingInstitutional(t, ctx, 'QA-M9 sem mídia');
    await env.service.approve({ tenant: ctx.tenant, actor: ctx.reviewer, itemId: small.itemId, input: {} }, t);
    assert.equal((await env.schedule(t, ctx, small.itemId, { channels: ['INSTAGRAM', 'LINKEDIN'], when: when() })).jobs.length, 2);
  });
});

test('autorizacao_guarda_medidas_e_recusa_medida_invalida', async () => {
  await env.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const f = await env.makeFile(t, ctx.tenant);
    const row = await env.authorize(t, ctx.tenant, f.id, 'EQUIPE', { width: 1080, height: 1920, durationS: 30 });
    assert.deepEqual([row.width, row.height, row.durationS], [1080, 1920, 30]);
    await env.rejectsCode(env.authorize(t, ctx.tenant, f.id, 'EQUIPE', { width: 0, height: 10 }), 400, 'MKT_VALIDATION');
    await env.rejectsCode(env.authorize(t, ctx.tenant, f.id, 'EQUIPE', { width: 1080 }), 400, 'MKT_VALIDATION');
    const again = await env.authorize(t, ctx.tenant, f.id, 'EQUIPE');
    assert.equal(again.width, null, 'reautorizar sem medidas limpa as medidas antigas');
  });
});
