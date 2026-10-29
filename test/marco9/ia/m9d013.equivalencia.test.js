'use strict';

// M9-D013 — as seis condições da equivalência segura do fallback, o código da falha fechada e os parâmetros (seletor direto, banco real).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { definirParametro } = require('../_helpers/iaOrcamento');
const { semearAprovada } = require('../_helpers/iaGolden');
const { linha, decisao, registroFalso } = require('../_helpers/iaFallback');
const { createFallbackSelector } = require('../../../src/features/ai/providers/fallback');
const { AI_SETTING_DEFAULTS, AI_SETTINGS_SCHEMA } = require('../../../src/features/ai/ai.settings');
const { liberarProducao } = require('../_helpers/iaLiberacao');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const ctxDe = (t) => ({ groupId: t.groupId, companyId: t.companyId, userId: t.userId });
const UNAVAILABLE = { kind: 'UNAVAILABLE', providerCode: 'a' };
const A = linha('prov-a', { safetyTier: 3 });

/** Chama o seletor e devolve a próxima decisão ou o erro (nunca lança). `over` muda a entrada do pedido. */
async function tentar(tx, linhas, cadeia, { origem = A, input = {}, usage = {}, error = UNAVAILABLE, attempt = 1, deps = {} } = {}) {
  const selector = createFallbackSelector({ registry: registroFalso([origem, ...linhas]), ...deps });
  const args = {
    decision: decisao(origem, cadeia), error, attempt, ctx: ctxDe(tenantA), transaction: tx,
    input: { agentCode: 'NAY_X', requiredCapabilities: ['generate'], politica: { classification: 'INTERNAL' }, ...input }, usage,
  };
  return selector(args).then((d) => ({ d }), (e) => ({ e }));
}
const semAvaliacao = (tx) => definirParametro(tenantA, 'ia.fallback.exigir_avaliacao_verde', false, tx);
const unsafe = (r) => { assert.equal(r.e && r.e.code, 'AI_FALLBACK_UNSAFE', r.e ? r.e.message : 'não falhou'); assert.equal(r.e.statusCode, 503); assert.equal(r.e.message, 'A NAY não está disponível agora. Nenhuma ação foi executada.'); };

test('m9d013_parametros_do_fallback_no_esquema_com_o_padrao_do_livro', () => {
  assert.equal(AI_SETTING_DEFAULTS['ia.fallback.max_saltos'], 2);
  assert.equal(AI_SETTING_DEFAULTS['ia.fallback.exigir_avaliacao_verde'], true);
  assert.deepEqual(AI_SETTINGS_SCHEMA['ia.fallback.max_saltos'], { type: 'integer', min: 1, max: 5 });
  assert.equal(AI_SETTINGS_SCHEMA['ia.fallback.exigir_avaliacao_verde'].type, 'boolean');
});

test('m9d013_fallback_para_tier_menor_recusado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await semAvaliacao(tx);
    const b = linha('prov-b', { safetyTier: 2 });
    unsafe(await tentar(tx, [b], [b], { input: { politica: { classification: 'CONFIDENTIAL' } } }));
    // O mesmo B com tier igual ao do original é aceito (para mostrar que o tier era a única razão).
    const igual = linha('prov-b', { safetyTier: 3 });
    const ok = await tentar(tx, [igual], [igual]);
    assert.equal(ok.d.provider, 'prov-b');
  });
});

test('m9d013_fallback_sem_structured_output_recusado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await semAvaliacao(tx);
    const semSchema = linha('prov-b', { structuredOutput: false });
    unsafe(await tentar(tx, [semSchema], [semSchema], { usage: { structuredOutput: true } }));
    const semTool = linha('prov-c', { toolUse: false });
    unsafe(await tentar(tx, [semTool], [semTool], { usage: { toolUse: true } }));
    // Capability exigida pelo pedido que o candidato não declara.
    const semVisao = linha('prov-d', { vision: false });
    unsafe(await tentar(tx, [semVisao], [semVisao], { input: { requiredCapabilities: ['generate', 'vision'] } }));
    // Se o original não usou schema nem tool, o candidato sem elas serve.
    assert.equal((await tentar(tx, [semSchema], [semSchema])).d.provider, 'prov-b');
  });
});

test('m9d013_restricted_nao_vai_para_provider_nao_permitido', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await semAvaliacao(tx);
    const origem = linha('prov-a', {}, { allowsRestricted: true, allowsConfidential: true, contractRef: 'c-1' });
    const comum = linha('prov-b', {}, {});
    const retem = linha('prov-c', { dataRetention: '30D' }, { allowsRestricted: true });
    for (const classification of ['RESTRICTED', 'CONFIDENTIAL']) {
      unsafe(await tentar(tx, [comum], [comum], { origem, input: { politica: { classification } } }));
    }
    // RESTRICTED também exige retenção NONE no candidato.
    unsafe(await tentar(tx, [retem], [retem], { origem, input: { politica: { classification: 'RESTRICTED' } } }));
    // Candidato com a permissão de RESTRICTED e retenção NONE é aceito.
    const permitido = linha('prov-d', {}, { allowsRestricted: true, allowsConfidential: true, contractRef: 'c-2' });
    assert.equal((await tentar(tx, [permitido], [permitido], { origem, input: { politica: { classification: 'RESTRICTED' } } })).d.provider, 'prov-d');
    // Retenção mais longa que a do original nunca serve, nem para dado interno.
    const longa = linha('prov-e', { dataRetention: 'PROVIDER_DEFAULT' });
    unsafe(await tentar(tx, [longa], [longa]));
    // A classificação aceita não diminui: o original aceita CONFIDENTIAL, o candidato não.
    unsafe(await tentar(tx, [comum], [comum], { origem }));
    // Região: dado confidencial não sai da região do original; interno pode.
    const outraRegiao = linha('prov-f', { region: 'US' }, { allowsConfidential: true, contractRef: 'c-3' });
    const origemConf = linha('prov-a', {}, { allowsConfidential: true, contractRef: 'c-0' });
    unsafe(await tentar(tx, [outraRegiao], [outraRegiao], { origem: origemConf, input: { politica: { classification: 'CONFIDENTIAL' } } }));
    assert.equal((await tentar(tx, [outraRegiao], [outraRegiao], { origem: origemConf })).d.provider, 'prov-f');
  });
});

test('m9d013_fallback_nunca_para_sandbox_em_producao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await semAvaliacao(tx);
    const sandbox = linha('ai-sandbox', {}, { labOnly: true });
    assert.equal((await tentar(tx, [sandbox], [sandbox])).d.provider, 'ai-sandbox', 'em laboratório o sandbox serve');
    await liberarProducao(tenantA, tx); // M9-D046: ir a PRODUCAO exige o portão de liberação completo
    await definirParametro(tenantA, 'ia.ambiente', 'PRODUCAO', tx);
    unsafe(await tentar(tx, [sandbox], [sandbox]));
  });
});

test('m9d013_avaliacao_verde_do_agente_para_o_candidato', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const b = linha('prov-b');
    unsafe(await tentar(tx, [b], [b]));
    await semearAprovada(tenantA, tx, { code: 'NAY_X', provider: 'prov-b', model: 'prov-b-m', suite: 'ALL' });
    assert.equal((await tentar(tx, [b], [b])).d.provider, 'prov-b', 'com avaliação aprovada do par, serve');
    // Avaliação de outro agente não vale para este.
    const c = linha('prov-c');
    await semearAprovada(tenantA, tx, { code: 'NAY_OUTRO', provider: 'prov-c', model: 'prov-c-m', suite: 'ALL' });
    unsafe(await tentar(tx, [c], [c]));
    // Desligada a exigência, o candidato sem avaliação serve.
    await semAvaliacao(tx);
    assert.equal((await tentar(tx, [c], [c])).d.provider, 'prov-c');
  });
});

test('m9d013_erro_de_configuracao_e_bloqueio_do_fornecedor_nao_acionam_o_fallback', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await semAvaliacao(tx);
    const b = linha('prov-b');
    for (const kind of ['AUTH', 'VALIDATION', 'SAFETY_BLOCKED']) {
      const r = await tentar(tx, [b], [b], { error: { kind, providerCode: 'a' } });
      assert.equal(r.d, null, `${kind} não troca de modelo`);
    }
    for (const kind of ['TIMEOUT', 'UNAVAILABLE', 'RATE_LIMIT']) {
      assert.equal((await tentar(tx, [b], [b], { error: { kind } })).d.provider, 'prov-b', `${kind} aciona`);
    }
  });
});

test('m9d013_codigo_unavailable_sem_candidato_e_unsafe_com_candidato_inseguro', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await semAvaliacao(tx);
    const seguro = linha('prov-b');
    const inseguro = linha('prov-c', { safetyTier: 1 });
    const indisponivel = (r) => { assert.equal(r.e && r.e.code, 'AI_PROVIDER_UNAVAILABLE'); assert.equal(r.e.statusCode, 503); assert.equal(r.e.message, 'O provedor de IA está indisponível no momento.'); };
    indisponivel(await tentar(tx, [], []));
    // Cadeia com um candidato que não está habilitado (fora do registro): nenhum elegível.
    indisponivel(await tentar(tx, [], [seguro]));
    // Candidato com circuito aberto: nenhum elegível.
    indisponivel(await tentar(tx, [seguro], [seguro], { deps: { circuitOpen: async () => true } }));
    // Candidato elegível mas inseguro: AI_FALLBACK_UNSAFE.
    unsafe(await tentar(tx, [inseguro], [inseguro]));
    // O primeiro inseguro é pulado e o segundo, seguro, é escolhido; a cadeia que sobra é a depois dele.
    const depois = linha('prov-d');
    const r = await tentar(tx, [inseguro, seguro, depois], [inseguro, seguro, depois]);
    assert.equal(r.d.provider, 'prov-b');
    assert.deepEqual(r.d.fallbackChain.map((l) => l.provider), ['prov-d']);
    // Acima do máximo de saltos o provedor está indisponível (padrão 2; o parâmetro vale).
    indisponivel(await tentar(tx, [seguro], [seguro], { attempt: 3 }));
    assert.equal((await tentar(tx, [seguro], [seguro], { attempt: 2 })).d.provider, 'prov-b');
    await definirParametro(tenantA, 'ia.fallback.max_saltos', 1, tx);
    indisponivel(await tentar(tx, [seguro], [seguro], { attempt: 2 }));
  });
});
