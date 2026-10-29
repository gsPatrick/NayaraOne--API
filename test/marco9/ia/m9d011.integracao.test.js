'use strict';

// M9-D011 — candidates() com conexões reais do registro (RLS), adapter real habilitado na avaliação de regressão e isolamento entre empresas.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { providerRegistry } = require('../../../src/features/ai/providers');
const { registerAiAdapters } = require('../../../src/features/ai/providers/builtIn');
const { AiEvaluationService } = require('../../../src/features/ai/evaluations');
const { hasEvalProvider } = require('../../../src/features/ai/evaluations/evalProviders');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { useTempSecretStore } = require('../_helpers/mktSecretStore');
const { startProviderServer } = require('../_helpers/iaProviderServer');
const { modelo, paraConfig, MODELO_EMBED } = require('../_helpers/iaAdapterCtx');
const H = require('../_helpers/iaAvaliacao');
const P = require('../_helpers/iaProviders');

let tenantA;
let tenantB;
let srv;
let semCofre;
before(async () => {
  ({ tenantA, tenantB } = await prepararTenants());
  await H.carregarPessoas();
  await P.prepararAmbiente(tenantA);
  registerAiAdapters();
  srv = await startProviderServer();
  semCofre = useTempSecretStore();
});
after(async () => { semCofre(); await srv.close(); await sequelize.close(); });

const nomes = (l) => l.map((c) => `${c.providerCode}/${c.model}`);
const modelos = (...m) => m.map(paraConfig);

test('m9d011_candidates_filtra_por_capability_com_conexoes_ativas', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    // Sem conexão real só o sandbox concorre (lab_only, fora de produção).
    assert.deepEqual(nomes(await providerRegistry.candidates({ capability: 'generate' }, tenantA, tx)), ['ai-sandbox/sandbox-1', 'ai-sandbox/sandbox-advanced-1']);
    assert.deepEqual(nomes(await providerRegistry.candidates({ capability: 'transcribe' }, tenantA, tx)), ['ai-sandbox/sandbox-media-1']);
    // Conexão em rascunho não conta; ativa, conta. O adapter que não declara a capability nunca é roteado.
    const rascunho = await P.criarConexao(tenantA, tx, { providerCode: 'openai', config: { models: modelos(modelo({ model: 'oa-gen', pricePerMTokIn: 0.5 }), MODELO_EMBED()) } });
    assert.deepEqual(nomes(await providerRegistry.candidates({ capability: 'embed' }, tenantA, tx)), ['ai-sandbox/sandbox-embed-1']);
    await P.registry.transitionConnection(rascunho.id, 'ACTIVE', P.comAdmin(tenantA), tx);
    await P.ativarConexao(tenantA, tx, { providerCode: 'anthropic', config: { models: modelos(modelo({ model: 'an-gen', pricePerMTokIn: 0.1 })) } });
    const embed = nomes(await providerRegistry.candidates({ capability: 'embed', requestSize: { tokensIn: 1000 } }, tenantA, tx));
    // 1.000 tokens: openai (R$ 1,00/Mtok) = 1000 micro-reais; sandbox (R$ 2,00/Mtok) = 2000. Só quem declara embed concorre.
    assert.deepEqual(embed, ['openai/m-emb', 'ai-sandbox/sandbox-embed-1']);
    assert.ok(!embed.some((n) => n.startsWith('anthropic')));
    const gerar = await providerRegistry.candidates({ capability: 'generate', requestSize: { tokensIn: 1000, tokensOut: 1000 } }, tenantA, tx);
    // 1.000 tokens de entrada e 1.000 de saída: sandbox 2+6 = 8.000; anthropic 0,10+15 = 15.100; openai 0,50+15 = 15.500 micro-reais.
    assert.deepEqual(gerar.map((c) => [`${c.providerCode}/${c.model}`, c.estimatedCostMicros]), [['ai-sandbox/sandbox-1', 8000], ['anthropic/an-gen', 15100], ['openai/oa-gen', 15500], ['ai-sandbox/sandbox-advanced-1', 40000]]);
    assert.deepEqual(nomes(await providerRegistry.candidates({ capability: 'analyzeImage' }, tenantA, tx)), ['ai-sandbox/sandbox-media-1']);
  });
});

test('m9d011_candidates_usa_politica_da_conexao_e_parametros_da_empresa', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await P.ativarConexao(tenantA, tx, { providerCode: 'openai', config: { data_retention: '30D', region: 'US', models: modelos(modelo({ model: 'oa-gen', safetyTier: 1 })) } });
    const por = async (q) => nomes(await providerRegistry.candidates({ capability: 'generate', ...q }, tenantA, tx));
    assert.deepEqual((await por({ politica: { retentions: ['NONE'] } })), ['ai-sandbox/sandbox-1', 'ai-sandbox/sandbox-advanced-1'], 'a retenção da conexão (30D) manda');
    assert.deepEqual(await por({ politica: { regions: ['US'] } }), ['openai/oa-gen']);
    // Dado CONFIDENTIAL só vai a provedor que o aceita; ligar exige ai:admin e contrato.
    assert.deepEqual(await por({ politica: { classification: 'CONFIDENTIAL' } }), [], 'nem o sandbox nem o openai aceitam confidencial sem allowsConfidential e contrato');
    // Agente crítico: oa-gen tem safetyTier 1 < 2 (parâmetro) e sai; baixando o piso para 1 ele volta.
    assert.deepEqual(await por({ criticidade: 'CRITICAL' }), ['ai-sandbox/sandbox-1', 'ai-sandbox/sandbox-advanced-1']);
    await P.ajustar(tenantA, 'ia.provedor.safety_tier_minimo_critico', 1, tx);
    assert.deepEqual((await por({ criticidade: 'CRITICAL' })).sort(), ['ai-sandbox/sandbox-1', 'ai-sandbox/sandbox-advanced-1', 'openai/oa-gen']);
    // Produção: o sandbox (lab_only) sai da lista.
    await P.ajustar(tenantA, 'ia.ambiente', 'PRODUCAO', tx);
    assert.deepEqual(await por({}), ['openai/oa-gen']);
  });
});

test('m9d011_conexao_de_uma_empresa_nao_aparece_para_a_outra', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await P.ativarConexao(tenantA, tx, { providerCode: 'openai', config: { models: modelos(modelo({ model: 'so-da-a' })) } });
    assert.ok(nomes(await providerRegistry.candidates({ capability: 'generate' }, tenantA, tx)).includes('openai/so-da-a'));
  });
  await withRollbackTenantTransaction(tenantB, async (tx) => {
    const ctxB = { ...tenantB, permissions: ['ai:admin'] };
    assert.ok(!nomes(await providerRegistry.candidates({ capability: 'generate' }, ctxB, tx)).includes('openai/so-da-a'));
    await P.recusa(providerRegistry.instance('openai', ctxB, tx), 'AI_PROVIDER_NOT_ENABLED', 409);
  });
});

test('m9d011_avaliacao_roda_com_adapter_real_registrado', async () => {
  const svc = new AiEvaluationService();
  assert.equal(hasEvalProvider('openai') && hasEvalProvider('anthropic'), true, 'o registry registrou os adapters reais na avaliação');
  assert.equal(hasEvalProvider('ai-sandbox'), true);
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = { ...H.ctxDe(tenantA), permissions: ['ai:evaluate'] };
    const { code } = await H.criarAgente(tenantA, tx);
    await H.ajustar('ia.avaliacao.permitir_provider_real', true, ctx, tx);
    // Sem conexão ativa o adapter real não responde: nenhum caso passa e a avaliação reprova (nunca "passa" por padrão).
    const sem = await H.avaliar(svc, ctx, tx, { agentCode: code, suite: 'golden', providerCode: 'openai' });
    assert.equal(sem.status, 'FAILED');
    // Com a conexão ativa e a credencial no cofre, a mesma avaliação chama o adapter (servidor falso, 127.0.0.1).
    const ref = P.refDe(tenantA, 'openai-eval');
    await P.ativarConexao(tenantA, tx, { providerCode: 'openai', secretRef: ref, segredo: 'sk-eval-segredo-123456', config: { baseUrl: srv.baseUrl, models: modelos(modelo({ model: 'oa-eval' })) } });
    const antes = srv.hits['/v1/chat/completions'] || 0;
    const real = await H.avaliar(svc, ctx, tx, { agentCode: code, suite: 'golden', providerCode: 'openai' });
    assert.equal(real.providerCode, 'openai');
    assert.equal(real.modelCode, 'oa-eval');
    assert.ok(real.items.length > 0);
    assert.ok(srv.hits['/v1/chat/completions'] - antes >= real.items.filter((i) => ['GROUNDING', 'HALLUCINATION', 'TOOL_SELECTION'].includes(i.category)).length, 'cada caso com modelo chamou o fornecedor');
    assert.ok(real.items.some((i) => Number(i.costAmount) > 0), 'custo real (8000 micro-reais por chamada) medido');
    assert.match(String(srv.server.lastHeaders.authorization), /sk-eval-segredo-123456/, 'credencial lida do cofre no instante da chamada');
  });
});
