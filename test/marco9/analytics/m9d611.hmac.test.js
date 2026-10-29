'use strict';

// M9-D611 (BI-003, 3.4 e 3.6) — filterHash assinado com HMAC do servidor: adulterado é recusado; detalhe sem permissão é 403; parâmetro da amostra.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env611 = require('../_helpers/m9d611Env');
const registry = require('../../../src/features/analytics/metrics');
const { upsertSetting, SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

const { FAMILIES, filterOf, ctxFor, inTx } = env611;
const f = FAMILIES[0];
let env;
before(async () => { env = await env611.setup(); });
after(() => env611.teardown(env));

const inA = (fn) => inTx(env.tenantA, {}, fn);
const refOf = async (ctx, tx, filter = filterOf(f)) => (await registry.buildSourceRefs(ctx, f.code, { filter, unit: f.unit }, tx)).sourceRefs[0];
const invalid = (e) => e.statusCode === 400 && e.code === 'ANALYTICS_FILTER_HASH_INVALID' && e.message === 'Filtro de detalhe inválido.';

test('m9d611 filterHash adulterado é recusado', async () => {
  await inA(async (tx) => {
    const ctx = await ctxFor(env, f, {}, tx);
    const ref = await refOf(ctx, tx);
    const ok = await registry.openSourceDetail(ctx, f.code, ref, tx);
    assert.equal(ok.count, f.inside.length);
    assert.equal(ok.ids.length, f.inside.length);
    // filtro mais amplo (período de um ano) com o hash e a assinatura do filtro autorizado
    await assert.rejects(registry.openSourceDetail(ctx, f.code, { ...ref, filter: { ...ref.filter, period: { from: '2025-01-01T03:00:00.000Z', to: '2027-01-01T03:00:00.000Z' } } }, tx), invalid);
    // status removido do filtro (mais linhas) mantendo o resto
    const { status, ...wider } = ref.filter;
    await assert.rejects(registry.openSourceDetail(ctx, f.code, { ...ref, filter: wider }, tx), invalid);
    // hash recalculado pelo atacante para o filtro amplo, mas sem a chave do servidor: a assinatura não bate
    const widerPeriod = { ...ref.filter, period: { from: '2025-01-01T03:00:00.000Z', to: '2027-01-01T03:00:00.000Z' } };
    await assert.rejects(registry.openSourceDetail(ctx, f.code, { ...ref, filter: widerPeriod, filterHash: registry.hashFilter(ref.table, widerPeriod) }, tx), invalid);
    await assert.rejects(registry.openSourceDetail(ctx, f.code, { ...ref, filterHash: '0'.repeat(64) }, tx), invalid);
    await assert.rejects(registry.openSourceDetail(ctx, f.code, { ...ref, filterSignature: 'a'.repeat(64) }, tx), invalid);
    await assert.rejects(registry.openSourceDetail(ctx, f.code, { ...ref, filterSignature: undefined }, tx), invalid);
  });
});

test('m9d611 filtro de outra empresa não abre detalhe nesta', async () => {
  const refB = await inTx(env.tenantB, {}, async (tx) => refOf(await ctxFor(env, f, { tenant: env.tenantB }, tx), tx));
  assert.equal(refB.count, 1, 'a empresa B tem só a própria linha (as da A não aparecem)');
  await inA(async (tx) => {
    const ctx = await ctxFor(env, f, {}, tx);
    await assert.rejects(registry.openSourceDetail(ctx, f.code, refB, tx), invalid);
    const refA = await refOf(ctx, tx);
    assert.notEqual(refA.filterHash, refB.filterHash, 'o hash cobre a empresa');
    assert.notEqual(refA.filterSignature, refB.filterSignature);
    assert.equal((await refOf(ctx, tx)).filterSignature, refA.filterSignature, 'a assinatura é determinística');
  });
});

test('m9d611 detalhe sem permissão é 403 ANALYTICS_DRILLDOWN_FORBIDDEN', async () => {
  await inA(async (tx) => {
    const ref = await refOf(await ctxFor(env, f, {}, tx), tx);
    const noDetail = await ctxFor(env, f, { detail: false }, tx);
    await assert.rejects(registry.openSourceDetail(noDetail, f.code, ref, tx), (e) => e.statusCode === 403 && e.code === 'ANALYTICS_DRILLDOWN_FORBIDDEN' && e.message === 'Você não tem permissão para ver o detalhe deste indicador.');
  });
});

test('m9d611 parâmetro analytics.rastreio.amostra_ids limita os ids da amostra', async () => {
  assert.ok(SETTINGS_SCHEMA['analytics.rastreio.amostra_ids'], 'declarado no SETTINGS_SCHEMA');
  await inA(async (tx) => {
    const ctx = await ctxFor(env, f, {}, tx);
    assert.equal((await refOf(ctx, tx)).idsSample.length, f.inside.length, 'padrão do livro: até 20');
    await upsertSetting('analytics.rastreio.amostra_ids', 2, env.tenantA, env.tenantA.userId, tx);
    assert.equal((await refOf(ctx, tx)).idsSample.length, 2);
    await upsertSetting('analytics.rastreio.amostra_ids', 0, env.tenantA, env.tenantA.userId, tx);
    const zero = await refOf(ctx, tx);
    assert.deepEqual(zero.idsSample, []);
    assert.equal(zero.count, f.inside.length);
    await assert.rejects(upsertSetting('analytics.rastreio.amostra_ids', 21, env.tenantA, env.tenantA.userId, tx), (e) => e.statusCode === 400);
  });
});
