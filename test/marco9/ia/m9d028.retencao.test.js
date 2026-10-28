'use strict';

// M9-D028 — retenção do conteúdo da NAY por classificação (maior entre as fontes), com o menor prazo entre a classificação e a
// retenção contratada do provider. Expurga só o conteúdo; metadados, custo e hashes ficam. Provider sandbox (sem chamada externa).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const retention = require('../../../src/features/ai/retention');
const { sequelize, q, run, carregarPessoas, ctxDe, prepararTenants, expectDbError } = require('../../helpers/aiRuns');
const { runVelho, lerRunCompleto, lerFonte, providerComRetencao } = require('../_helpers/iaRetencao');

let tenantA;
let tenantB;
before(async () => { ({ tenantA, tenantB } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const expurgado = async (id, tx) => (await lerRunCompleto(id, tx)).content_purged_at !== null;

test('m9d028_retencao_por_classificacao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = ctxDe(tenantA);
    const casos = [
      // [rótulo, dias, fontes, esperado expurgado]
      ['RESTRICTED 31 dias', 31, ['RESTRICTED'], true],
      ['RESTRICTED 29 dias', 29, ['RESTRICTED'], false],
      ['CONFIDENTIAL 181 dias', 181, ['CONFIDENTIAL'], true],
      ['CONFIDENTIAL 179 dias', 179, ['CONFIDENTIAL'], false],
      ['INTERNAL 366 dias', 366, ['INTERNAL'], true],
      ['INTERNAL 364 dias', 364, ['INTERNAL'], false],
      ['PUBLIC 366 dias', 366, ['PUBLIC'], true],
      ['PUBLIC 364 dias', 364, ['PUBLIC'], false],
      ['sem fontes vale INTERNAL: 200 dias', 200, [], false],
      ['sem fontes vale INTERNAL: 366 dias', 366, [], true],
      ['a MAIOR classificação manda (RESTRICTED + PUBLIC, 40 dias)', 40, ['PUBLIC', 'RESTRICTED', 'INTERNAL'], true],
      ['PUBLIC + INTERNAL, 40 dias não vence', 40, ['PUBLIC', 'INTERNAL'], false],
    ];
    const criados = [];
    for (const [rotulo, dias, fontes, esperado] of casos) criados.push({ rotulo, esperado, ...(await runVelho(tenantA, tx, { diasAtras: dias, fontes })) });
    const r = await retention.purgeExpiredAiContent(ctx, tx);
    for (const c of criados) assert.equal(await expurgado(c.id, tx), c.esperado, c.rotulo);
    assert.equal(r.runs, criados.filter((c) => c.esperado).length);
    // O prazo é parâmetro da empresa: RESTRICTED passa a 10 dias.
    const recente = await runVelho(tenantA, tx, { diasAtras: 11, fontes: ['RESTRICTED'] });
    assert.equal(await expurgado(recente.id, tx), false);
    await upsertSetting('ia.retencao.restricted_dias', 10, ctx, ctx.userId, tx);
    await retention.purgeExpiredAiContent(ctx, tx);
    assert.equal(await expurgado(recente.id, tx), true, 'o parâmetro ia.retencao.restricted_dias vale');
    // Fontes do run expurgado perdem o trecho, mas continuam registradas.
    const f = await lerFonte(criados[0].fontes[0], tx);
    assert.equal(f.excerpt, null); assert.ok(f.content_purged_at); assert.equal(f.classification, 'RESTRICTED');
  });
});

test('m9d028_prazo_menor_entre_classificacao_e_provider', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = ctxDe(tenantA);
    const p30 = await providerComRetencao(tenantA, tx, '30D');
    const pPadrao = await providerComRetencao(tenantA, tx, 'PROVIDER_DEFAULT');
    const pNenhuma = await providerComRetencao(tenantA, tx, 'NONE');
    const a = await runVelho(tenantA, tx, { diasAtras: 40, fontes: ['INTERNAL'], providerCode: p30 });
    const b = await runVelho(tenantA, tx, { diasAtras: 40, fontes: ['INTERNAL'], providerCode: pPadrao });
    const c = await runVelho(tenantA, tx, { diasAtras: 40, fontes: ['INTERNAL'], providerCode: pNenhuma });
    const d = await runVelho(tenantA, tx, { diasAtras: 20, fontes: ['INTERNAL'], providerCode: p30 });
    const e = await runVelho(tenantA, tx, { diasAtras: 40, fontes: ['INTERNAL'], providerCode: null });
    // Provider 30D e classificação com prazo MENOR (RESTRICTED a 10 dias): vale o menor dos dois.
    await upsertSetting('ia.retencao.restricted_dias', 10, ctx, ctx.userId, tx);
    const f = await runVelho(tenantA, tx, { diasAtras: 15, fontes: ['RESTRICTED'], providerCode: p30 });
    await retention.purgeExpiredAiContent(ctx, tx);
    assert.equal(await expurgado(a.id, tx), true, '30D contratado: 40 dias passa do prazo efetivo de 30');
    assert.equal(await expurgado(b.id, tx), false, 'PROVIDER_DEFAULT: vale o prazo por classificação (365)');
    assert.equal(await expurgado(c.id, tx), false, 'NONE: o fornecedor não retém, vale o prazo por classificação');
    assert.equal(await expurgado(d.id, tx), false, '20 dias está dentro dos 30');
    assert.equal(await expurgado(e.id, tx), false, 'sem provider vale a classificação');
    assert.equal(await expurgado(f.id, tx), true, 'o menor entre 30 (provider) e 10 (RESTRICTED)');
  });
});

test('m9d028_expurgo_mantem_metadados_e_custo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = ctxDe(tenantA);
    const velho = await runVelho(tenantA, tx, { diasAtras: 31, fontes: ['RESTRICTED'], custo: '2.345678', tokensIn: 321, tokensOut: 123 });
    const antes = await lerRunCompleto(velho.id, tx);
    await retention.purgeExpiredAiContent(ctx, tx);
    const depois = await lerRunCompleto(velho.id, tx);
    for (const campo of ['input_summary', 'output_summary']) { assert.ok(antes[campo]); assert.equal(depois[campo], null, campo); }
    assert.ok(depois.content_purged_at);
    for (const campo of ['id', 'status', 'cost_amount', 'tokens_in', 'tokens_out', 'request_hash', 'created_at', 'finished_at', 'agent_name', 'provider_code']) {
      assert.deepEqual(depois[campo], antes[campo], campo);
    }
    assert.equal(depois.cost_amount, '2.345678');
    // Chamada de ferramenta: nome e estado ficam; argumentos e resultado saem.
    assert.deepEqual(depois.tool_calls_json, [{ tool: 'crm.buscar', status: 'OK' }]);
    const [soma] = await q('SELECT SUM(cost_amount)::text AS s FROM ai.ai_runs WHERE id = :id', { id: velho.id }, tx);
    assert.equal(soma.s, '2.345678');
    const fonte = await lerFonte(velho.fontes[0], tx);
    assert.equal(fonte.excerpt, null); assert.equal(fonte.content_hash, 'd'.repeat(64)); assert.match(fonte.source_ref, /^doc:/);
    // Repetir o expurgo não muda nada.
    const outra = await retention.purgeExpiredAiContent(ctx, tx);
    assert.equal(outra.runs, 0); assert.equal(outra.sources, 0);
    // O run continua imutável fora do expurgo, e a marca de expurgo só aceita APAGAR conteúdo.
    await expectDbError(tx, "UPDATE ai.ai_runs SET output_summary = 'novo texto' WHERE id = :id", { id: velho.id }, /AI_RUN_IMMUTABLE/);
    await run("SELECT set_config('ai.purge_mode', 'on', true)", {}, tx);
    await expectDbError(tx, "UPDATE ai.ai_runs SET output_summary = 'texto forjado', content_purged_at = now() WHERE id = :id", { id: velho.id }, /AI_RUN_IMMUTABLE/);
  });
});

test('m9d028_expurgo_isola_empresas', async () => {
  await withRollbackTenantTransaction(tenantB, async (txB) => {
    const deB = await runVelho(tenantB, txB, { diasAtras: 400, fontes: ['PUBLIC'] });
    // A mesma sessão da empresa B não expurga linhas de A e vice-versa: o expurgo da empresa A, em outra transação, não toca B.
    await withRollbackTenantTransaction(tenantA, async (txA) => {
      const r = await retention.purgeExpiredAiContent(ctxDe(tenantA), txA);
      assert.equal(typeof r.runs, 'number');
    });
    assert.equal(await expurgado(deB.id, txB), false);
    await retention.purgeExpiredAiContent(ctxDe(tenantB), txB);
    assert.equal(await expurgado(deB.id, txB), true);
  });
});

test('m9d028_parametros_de_retencao_validados', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = ctxDe(tenantA);
    for (const [chave, valor] of [['ia.retencao.public_dias', 0], ['ia.retencao.internal_dias', 'abc'], ['ia.retencao.confidential_dias', 99999], ['ia.retencao.restricted_dias', 1.5]]) {
      await assert.rejects(upsertSetting(chave, valor, ctx, ctx.userId, tx), { code: 'SETTING_INVALID_VALUE' }, chave);
    }
    const p = await retention.readRetentionParams(ctx, tx);
    assert.deepEqual([p.publicDias, p.internalDias, p.confidentialDias, p.restrictedDias], [365, 365, 180, 30]);
  });
});
