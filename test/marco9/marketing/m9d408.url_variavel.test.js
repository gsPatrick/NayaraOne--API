'use strict';

// M9-D408 / M9-D433 (rodada 5, M-3) — o endereço ambíguo que chega por VARIÁVEL do pedido de conteúdo (não pelo texto da NAY) também impede a autopublicação:
// o passo da marca varre o texto final renderizado, grava `revisao` em checks.branding e o conteúdo vai a PENDING_APPROVAL com o motivo URL_REVIEW.
// Banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d408.url_variavel.test.js
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktAutopublish');
const fx = require('../_helpers/m9d431Fixtures');
const { evaluateAutopublish } = require('../../../src/features/marketing/content/autopublish.policy');

let ctx;
before(async () => { ctx = await env.setup(); });
after(async () => { await sequelize.close(); });
afterEach(env.reset);

const inTx = (fn) => env.withRollbackTenantTransaction(ctx.tenant, fn);
const checksOf = async (t, itemId) => (await fx.q(t, 'SELECT v.checks_json FROM marketing.content_items i JOIN marketing.content_versions v ON v.id = i.current_version_id WHERE i.id = :i', { i: itemId }))[0].checks_json;

test('variavel_com_endereco_ambiguo_nao_autopublica_e_grava_revisao_no_passo_da_marca', async () => {
  await inTx(async (t) => {
    await env.setClasses(t, ctx.tenant, [env.SOLD_CLASS]);
    for (const bairro of ['planta.pdf', 'Av.Paulista', 'Compre.Agora']) {
      env.registerNay();
      const c = await env.soldContent(t, ctx, { variables: { bairro } });
      assert.equal(c.status, 'PENDING_APPROVAL', bairro);
      assert.equal((await env.jobsOf(t, c.itemId)).length, 0, bairro);
      assert.equal((await env.itemOf(t, c.itemId)).approved_by, null, bairro);
      assert.equal((await env.eventsOf(t, c.itemId)).length, 0, bairro);
      const checks = await checksOf(t, c.itemId);
      assert.deepEqual(checks.branding.detalhes.revisao.map((r) => r.url), [bairro], bairro);
      assert.ok(!checks.factual.detalhes.revisao, 'o passo factual não vê a variável: o aviso vem do passo da marca');
    }
  });
});

test('a_politica_recusa_com_URL_REVIEW_quando_so_o_passo_da_marca_tem_revisao', async () => {
  await inTx(async (t) => {
    await env.setClasses(t, ctx.tenant, [env.SOLD_CLASS]);
    env.registerNay();
    const clean = await env.soldContent(t, ctx);
    assert.equal(clean.status, 'SCHEDULED', 'sem variável ambígua o mesmo conteúdo sai sozinho');
    env.registerNay();
    const c = await env.soldContent(t, ctx, { variables: { bairro: 'Av.Paulista' } });
    const item = (await fx.q(t, 'SELECT * FROM marketing.content_items WHERE id = :i', { i: c.itemId }))[0];
    const version = (await fx.q(t, 'SELECT * FROM marketing.content_versions WHERE id = :v', { v: item.current_version_id }))[0];
    const out = await evaluateAutopublish({ item: { ...item, status: 'COMPLIANCE_CHECKED' }, version, tenant: ctx.tenant, transaction: t });
    assert.equal(out.autopublish, false);
    assert.ok(out.reasons.includes('URL_REVIEW'), out.reasons.join(','));
  });
});

test('variavel_hostil_continua_recusada_com_422_e_variavel_enorme_ou_array_gigante_tambem_sem_500', async () => {
  await inTx(async (t) => {
    await env.setClasses(t, ctx.tenant, [env.SOLD_CLASS]);
    env.registerNay();
    await assert.rejects(() => env.soldContent(t, ctx, { variables: { bairro: 'evil.com/login' } }), (e) => e.statusCode === 422 && e.code === 'MKT_URL_NOT_ALLOWED');
    for (const variables of [{ bairro: 'x'.repeat(5000) }, { bairro: new Array(130000).fill('a') }, { bairro: 'a'.repeat(20) , outra: 'evil.com/'.concat('.'.repeat(60000)) }]) {
      env.registerNay();
      const started = Date.now();
      await assert.rejects(() => env.soldContent(t, ctx, { variables }), (e) => e.statusCode === 422 && e.code === 'MKT_URL_NOT_ALLOWED');
      assert.ok(Date.now() - started < 3000, 'recusa rápida, antes de varrer');
    }
  });
});
