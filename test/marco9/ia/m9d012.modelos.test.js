'use strict';

// M9-D012 — modelo pequeno e avançado, capabilities (falha fechada), latência, conjuntos de tarefas, limite do pequeno e dois provedores de preço diferente.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { novoRoteador, entrada, tenantCtx, LIVRE } = require('../_helpers/iaRouter');
const P = require('../_helpers/iaProviders');
const H = require('../_helpers/iaAvaliacao');
const { modelo, paraConfig } = require('../_helpers/iaAdapterCtx');
const { useTempSecretStore } = require('../_helpers/mktSecretStore');
const { liberarProducao } = require('../_helpers/iaLiberacao');

let tenantA;
let semCofre;
before(async () => {
  ({ tenantA } = await prepararTenants());
  await H.carregarPessoas();
  await P.prepararAmbiente(tenantA);
  semCofre = useTempSecretStore();
});
after(async () => { semCofre(); await sequelize.close(); });

const decide = (router, tx, over) => router.decide(entrada({ budgetState: LIVRE, ...over }), tenantCtx(tenantA), tx);
const rejeita = (p, status, code) => P.recusa(p, code, status);

test('m9d012_classificacao_usa_modelo_pequeno', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { router } = novoRoteador();
    for (const taskType of ['classificar', 'triar', 'extrair_simples', 'resumir_curto', 'reescrever_curto']) {
      const d = await decide(router, tx, { taskType });
      assert.equal(d.path, 'SMALL_MODEL', taskType);
      assert.equal(d.provider, 'ai-sandbox');
      assert.equal(d.model, 'sandbox-1');
      assert.equal(d.classe, 'SMALL');
      assert.equal(d.reason, 'SMALL_TASK');
    }
    // Tarefa fora dos dois conjuntos começa no pequeno (o mais barato) e pode escalar.
    const livre = await decide(router, tx, { taskType: 'responder_pergunta' });
    assert.equal(livre.path, 'SMALL_MODEL');
    assert.equal(livre.reason, 'SMALL_DEFAULT_UNLISTED_TASK');
  });
});

test('m9d012_comparacao_usa_avancado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { router } = novoRoteador();
    for (const taskType of ['raciocinar_multietapas', 'comparar_documentos', 'minuta_juridica', 'analisar_documento_complexo']) {
      const d = await decide(router, tx, { taskType });
      assert.equal(d.path, 'ADVANCED_MODEL', taskType);
      assert.equal(d.model, 'sandbox-advanced-1');
      assert.equal(d.reason, 'ADVANCED_TASK');
    }
    // Entrada acima do limite do pequeno (ia.router.resumo_simples_max_tokens, padrão 2.000) vai ao avançado.
    assert.equal((await decide(router, tx, { taskType: 'resumir_curto', inputSize: 2000 })).path, 'SMALL_MODEL');
    const longa = await decide(router, tx, { taskType: 'resumir_curto', inputSize: 2001 });
    assert.equal(longa.path, 'ADVANCED_MODEL');
    assert.equal(longa.reason, 'ADVANCED_INPUT_ABOVE_SMALL_LIMIT');
    // O limite é parâmetro da empresa.
    await P.ajustar(tenantA, 'ia.router.resumo_simples_max_tokens', 50, tx);
    assert.equal((await decide(router, tx, { taskType: 'classificar', inputSize: 51 })).path, 'ADVANCED_MODEL');
    // Documento longo não confiável também pede o avançado.
    const docs = await decide(router, tx, { taskType: 'classificar', inputSize: 10, hasUntrustedLongDocs: true });
    assert.equal(docs.reason, 'ADVANCED_LONG_UNTRUSTED_DOCUMENTS');
  });
});

test('m9d012_sem_capability_falha_fechada', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { router } = novoRoteador();
    // Nenhum modelo do sandbox declara visão em geração de texto avançado nem saída estruturada fora do catálogo: capability inexistente.
    const err = await rejeita(decide(router, tx, { taskType: 'classificar', requiredCapabilities: ['generate', 'vision'] }), 503, 'AI_NO_ELIGIBLE_MODEL');
    assert.equal(err.message, 'Nenhum modelo disponível atende a esta tarefa com segurança.');
    await rejeita(decide(router, tx, { taskType: 'classificar', requiredCapabilities: ['capability-que-nao-existe'] }), 503, 'AI_NO_ELIGIBLE_MODEL');
    // O modelo avançado faz toolUse e structuredOutput: as duas capacidades de modelo são aceitas.
    const ok = await decide(router, tx, { taskType: 'comparar_documentos', requiredCapabilities: ['generate', 'toolUse', 'structuredOutput'] });
    assert.equal(ok.path, 'ADVANCED_MODEL');
    // Produção: o sandbox (lab_only) sai e, sem conexão real, não há candidato.
    await liberarProducao(tenantA, tx); // M9-D046: ir a PRODUCAO exige o portão de liberação completo
    await P.ajustar(tenantA, 'ia.ambiente', 'PRODUCAO', tx);
    await rejeita(decide(router, tx, { taskType: 'classificar' }), 503, 'AI_NO_ELIGIBLE_MODEL');
    // Entrada maior que a janela do modelo também não tem candidato.
    await P.ajustar(tenantA, 'ia.ambiente', 'LAB', tx);
    await rejeita(decide(router, tx, { taskType: 'comparar_documentos', inputSize: 100001 }), 503, 'AI_NO_ELIGIBLE_MODEL');
  });
});

test('m9d012_latencia_exclui_candidato_lento', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { router } = novoRoteador();
    // sandbox-1 tem p95 de 100 ms e o avançado, de 400 ms.
    assert.equal((await decide(router, tx, { taskType: 'comparar_documentos', latencyBudgetMs: 400 })).model, 'sandbox-advanced-1');
    await rejeita(decide(router, tx, { taskType: 'comparar_documentos', latencyBudgetMs: 399 }), 503, 'AI_NO_ELIGIBLE_MODEL');
    assert.equal((await decide(router, tx, { taskType: 'classificar', latencyBudgetMs: 100 })).model, 'sandbox-1');
    await rejeita(decide(router, tx, { taskType: 'classificar', latencyBudgetMs: 99 }), 503, 'AI_NO_ELIGIBLE_MODEL');
  });
});

test('m9d012_escolhe_pelo_registro_entre_dois_provedores_de_preco_diferente', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { router } = novoRoteador();
    const barato = modelo({ model: 'oa-barato', pricePerMTokIn: 0.1, pricePerMTokOut: 0.2, dataRetention: 'NONE', region: 'BR' });
    const caro = modelo({ model: 'an-caro', pricePerMTokIn: 9, pricePerMTokOut: 40, dataRetention: 'NONE', region: 'BR' });
    await P.ativarConexao(tenantA, tx, { providerCode: 'openai', config: { models: [paraConfig(barato)], data_retention: 'NONE', region: 'BR' } });
    await P.ativarConexao(tenantA, tx, { providerCode: 'anthropic', config: { models: [paraConfig(caro)], data_retention: 'NONE', region: 'BR' } });
    const d = await decide(router, tx, { taskType: 'classificar', inputSize: 1000, maxOutputTokens: 500 });
    assert.equal(d.provider, 'openai', 'o mais barato para o pedido vence');
    assert.equal(d.model, 'oa-barato');
    // A cadeia de fallback traz os demais da mesma classe, do mais barato ao mais caro.
    assert.deepEqual(d.fallbackChain.map((c) => `${c.provider}/${c.model}`), ['ai-sandbox/sandbox-1', 'anthropic/an-caro']);
    // O adapter vem do registro (nunca de fábrica própria).
    const { providerRegistry } = require('../../../src/features/ai/providers');
    const adapter = await providerRegistry.instance(d.provider, tenantCtx(tenantA), tx);
    assert.equal(adapter.providerCode(), 'openai');
  });
});
