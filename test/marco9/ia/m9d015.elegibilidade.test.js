'use strict';

// M9-D015 — elegibilidade do cache (classificação, PII, ação, grounding, lista da versão do agente, parâmetros) e chave sem modelo.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { definirParametro } = require('../_helpers/iaOrcamento');
const { fonteIndexada, dados, entradaLookup, contar } = require('../_helpers/iaCache');
const cache = require('../../../src/features/ai/budgets/cache.service');
const { scopeKey, cacheKey, requestHash } = require('../../../src/features/ai/budgets/cache.key');
const { AI_SETTING_DEFAULTS, AI_SETTINGS_SCHEMA } = require('../../../src/features/ai/ai.settings');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const ctxDe = (t) => ({ groupId: t.groupId, companyId: t.companyId, userId: t.userId });
const ligar = (tx) => definirParametro(tenantA, 'ia.cache.habilitado', true, tx);
const guardar = (d, tx) => cache.store(ctxDe(tenantA), d, tx);

test('m9d015_padrao_desligado_e_parametros_no_esquema', async () => {
  assert.equal(AI_SETTING_DEFAULTS['ia.cache.habilitado'], false);
  assert.equal(AI_SETTING_DEFAULTS['ia.cache.ttl_segundos'], 900);
  assert.equal(AI_SETTINGS_SCHEMA['ia.cache.habilitado'].type, 'boolean');
  assert.equal(AI_SETTINGS_SCHEMA['ia.cache.ttl_segundos'].type, 'integer');
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const d = dados([await fonteIndexada(tenantA, tx)]);
    assert.deepEqual(await guardar(d, tx), { stored: false, reason: 'DISABLED' });
    assert.equal(await cache.lookup(entradaLookup(d), { tenant: tenantA, transaction: tx }), null);
    assert.equal(await contar(tx), 0);
  });
});

test('m9d015_cache_nao_guarda_confidential_nem_restricted', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await ligar(tx);
    for (const classification of ['CONFIDENTIAL', 'RESTRICTED', 'DESCONHECIDA']) {
      const r = await guardar(dados([await fonteIndexada(tenantA, tx, { classification })]), tx);
      assert.deepEqual(r, { stored: false, reason: 'CLASSIFICATION' }, classification);
    }
    // Uma fonte sensível entre várias inelegíveis a resposta toda.
    const mista = dados([await fonteIndexada(tenantA, tx), await fonteIndexada(tenantA, tx, { classification: 'CONFIDENTIAL' })]);
    assert.equal((await guardar(mista, tx)).stored, false);
    assert.equal(await contar(tx), 0);
    for (const classification of ['PUBLIC', 'INTERNAL']) {
      assert.equal((await guardar(dados([await fonteIndexada(tenantA, tx, { classification })], { input: `Pergunta ${classification}` }), tx)).stored, true, classification);
    }
  });
});

test('m9d015_cache_nao_guarda_pii', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await ligar(tx);
    const fonte = await fonteIndexada(tenantA, tx);
    const casos = {
      'CPF na saída': { answer: 'O cliente com CPF 111.444.777-35 tem reembolso [1].' },
      'e-mail na entrada': { input: 'O prazo para maria.silva@empresa.com.br?' },
      'CPF na entrada': { input: 'Reembolso do CPF 111.444.777-35' },
    };
    for (const [nome, over] of Object.entries(casos)) assert.deepEqual(await guardar(dados([fonte], over), tx), { stored: false, reason: 'PII' }, nome);
    const comPii = await fonteIndexada(tenantA, tx, { text: 'Fale com joao@empresa.com.br sobre o reembolso.' });
    assert.deepEqual(await guardar(dados([comPii]), tx), { stored: false, reason: 'PII' }, 'PII no trecho da fonte');
    assert.equal(await contar(tx), 0);
  });
});

test('m9d015_acao_nunca_cacheada', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await ligar(tx);
    const fonte = await fonteIndexada(tenantA, tx);
    assert.deepEqual(await guardar(dados([fonte], { isAction: true }), tx), { stored: false, reason: 'ACTION' });
    for (const groundingStatus of ['INSUFFICIENT_SOURCES', 'UNGROUNDED', undefined]) {
      assert.deepEqual(await guardar(dados([fonte], { groundingStatus }), tx), { stored: false, reason: 'NOT_GROUNDED' }, String(groundingStatus));
    }
    // Fonte que não é do índice (memória, leitura de dado, ferramenta) nunca entra.
    for (const sourceType of ['MEMORY', 'READ_MODEL', 'TOOL']) {
      assert.equal((await guardar(dados([await fonteIndexada(tenantA, tx, { sourceType })]), tx)).reason, 'SOURCE_TYPE', sourceType);
    }
    assert.equal(await contar(tx), 0);
    assert.equal((await guardar(dados([fonte], { groundingStatus: 'NOT_APPLICABLE' }), tx)).stored, true);
  });
});

test('m9d015_chave_sem_modelo_e_cacheable_no_model_policy', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await ligar(tx);
    const fonte = await fonteIndexada(tenantA, tx);
    const a = await guardar(dados([fonte], { providerCode: 'ai-sandbox', modelCode: 'sandbox-1' }), tx);
    const b = await guardar(dados([fonte], { providerCode: 'outro', modelCode: 'modelo-novo' }), tx);
    assert.equal(a.key, b.key, 'trocar o modelo na mesma versão não muda a chave');
    assert.equal(await contar(tx), 1, 'a mesma chave renova a entrada, não duplica');
    // A versão do agente muda a chave (trocar o modelo cria outra versão, com outro config_hash).
    assert.notEqual((await guardar(dados([fonte], { agentVersion: 2 }), tx)).key, a.key);
    // Só tarefa listada em cacheableTaskTypes é cacheada.
    assert.deepEqual(await guardar(dados([fonte], { cacheableTaskTypes: [] }), tx), { stored: false, reason: 'TASK_NOT_CACHEABLE' });
    assert.deepEqual(await guardar(dados([fonte], { cacheableTaskTypes: ['outra_tarefa'] }), tx), { stored: false, reason: 'TASK_NOT_CACHEABLE' });
    const d = dados([fonte]);
    assert.ok(await cache.lookup(entradaLookup(d), { tenant: tenantA, transaction: tx }), 'tarefa listada acerta');
    assert.equal(await cache.lookup(entradaLookup({ ...d, cacheableTaskTypes: [] }), { tenant: tenantA, transaction: tx }), null, 'fora da lista nunca acerta, mesmo com a entrada gravada');
    // Com o parâmetro desligado nada é lido nem gravado.
    await definirParametro(tenantA, 'ia.cache.habilitado', false, tx);
    assert.equal(await cache.lookup(entradaLookup(d), { tenant: tenantA, transaction: tx }), null);
    // A chave pura não tem parâmetro de modelo.
    const escopo = scopeKey({ companyId: 'c', agentCode: 'X', agentVersion: 1, taskType: 't', permissions: ['a'], request: requestHash({ taskType: 't', input: 'i', purpose: 'p' }) });
    assert.equal(cacheKey.length, 2, 'cacheKey(escopo, { fontes, snapshot }) não recebe modelo');
    assert.equal(cacheKey(escopo, { sources: [], snapshotAt: null }), cacheKey(escopo, { sources: [], snapshotAt: null }));
  });
});

test('m9d015_validade_pelo_ttl_do_parametro', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await ligar(tx);
    await definirParametro(tenantA, 'ia.cache.ttl_segundos', 60, tx);
    const d = dados([await fonteIndexada(tenantA, tx)]);
    const { key } = await guardar(d, tx);
    const [linha] = await sequelize.query('SELECT extract(epoch FROM (expires_at - created_at))::int AS s FROM ai.cache_entries WHERE key = :key', { replacements: { key }, transaction: tx, type: 'SELECT' });
    assert.equal(linha.s, 60);
    await sequelize.query("UPDATE ai.cache_entries SET expires_at = now() - interval '1 second', created_at = now() - interval '2 seconds' WHERE key = :key", { replacements: { key }, transaction: tx });
    assert.equal(await cache.lookup(entradaLookup(d), { tenant: tenantA, transaction: tx }), null, 'vencida não acerta');
  });
});
