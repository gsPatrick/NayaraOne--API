'use strict';

// M9-D010 — AIProviderAdapter: interface comum, capacidades, custo e catálogo. Sem banco: o servidor do fornecedor é falso (127.0.0.1).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startProviderServer } = require('../_helpers/iaProviderServer');
const { casosDeContrato } = require('../_helpers/iaAdapterCases');
const { assertContract, assertEmbedShape, pedido } = require('../_helpers/iaAdapterContract');
const { realCtx, modelo } = require('../_helpers/iaAdapterCtx');
const { AIProviderAdapter } = require('../../../src/features/ai/providers/AIProviderAdapter');
const { AnthropicAdapter } = require('../../../src/features/ai/providers/anthropic/AnthropicAdapter');
const { OpenAIAdapter } = require('../../../src/features/ai/providers/openai/OpenAIAdapter');
const { costMicros, costAmount, microsToAmount } = require('../../../src/features/ai/providers/providers.cost');
const { IntegrationAdapter } = require('../../../src/features/integrations/registry/IntegrationAdapter');
const { AiAdapter } = require('../../../src/features/integrations/providers/ai/ai.port');
const { validateAdapterClass } = require('../../../src/features/integrations/registry/adapterContract');

let srv;
let casos;
before(async () => { srv = await startProviderServer(); casos = casosDeContrato(srv.baseUrl); });
after(async () => { await srv.close(); });

test('m9d010_contrato_todos_os_adapters', async () => {
  for (const c of casos) await assertContract(c);
});

test('m9d010_capacidade_nao_suportada_erro_explicito', async () => {
  // O erro é SÍNCRONO (nada de promessa rejeitada): quem chama enxerga na hora.
  class SoGerar extends AIProviderAdapter {
    providerCode() { return 'so-gerar'; }

    capabilities() { return ['generate']; }

    healthCheck() { return { ok: true }; }

    async generate() { return {}; }
  }
  const a = new SoGerar(null);
  for (const op of ['embed', 'transcribe', 'analyzeImage']) {
    assert.throws(() => a[op]({}), (e) => e.code === 'AI_CAPABILITY_UNSUPPORTED' && e.statusCode === 501 && e.message === 'O provedor não suporta esta capacidade.');
  }
  // Os reais: o que não declaram cai no mesmo erro.
  const anth = new AnthropicAdapter(realCtx('anthropic', srv.baseUrl));
  ['embed', 'transcribe', 'analyzeImage'].forEach((op) => assert.throws(() => anth[op]({}), { code: 'AI_CAPABILITY_UNSUPPORTED' }));
  const oa = new OpenAIAdapter(realCtx('openai', srv.baseUrl));
  ['transcribe', 'analyzeImage'].forEach((op) => assert.throws(() => oa[op]({}), { code: 'AI_CAPABILITY_UNSUPPORTED' }));
  // Modelo que não faz a operação (declarada pelo adapter, mas o modelo é só de geração) também é recusado.
  await assert.rejects(oa.embed({ model: 'm-gen', inputs: ['x'] }), { code: 'AI_CAPABILITY_UNSUPPORTED' });
  // Modelo que não está no catálogo é VALIDATION, nunca um "parecido".
  await assert.rejects(oa.generate(pedido('inexistente', 'oi')), (e) => e.kind === 'VALIDATION');
});

test('m9d010_custo_seis_casas', async () => {
  // Exemplo do livro: 1.000 tokens de entrada a R$ 5,00 por milhão = 0,005000.
  assert.equal(costAmount({ tokensIn: 1000, tokensOut: 0 }, { pricePerMTokIn: 5, pricePerMTokOut: 0 }), '0.005000');
  assert.equal(costAmount({ tokensIn: 1000, tokensOut: 200 }, { pricePerMTokIn: '5', pricePerMTokOut: '15,00' }), '0.008000');
  // Dinheiro sem ponto flutuante: 3 milhões de tokens a 0,333333 = 0,999999 (0.1 + 0.2 daria 0,30000000000000004).
  assert.equal(costAmount({ tokensIn: 3000000, tokensOut: 0 }, { pricePerMTokIn: '0.333333', pricePerMTokOut: 0 }), '0.999999');
  assert.equal(costAmount({ tokensIn: 1, tokensOut: 0 }, { pricePerMTokIn: '0.5', pricePerMTokOut: 0 }), '0.000001', 'meio centavo de micro arredonda para cima');
  assert.equal(costMicros({ tokensIn: 0, tokensOut: 0, pricePerMTokIn: 5, pricePerMTokOut: 5 }), 0);
  assert.equal(microsToAmount(1234567), '1.234567');
  assert.throws(() => costMicros({ tokensIn: 1, pricePerMTokIn: -1 }), TypeError);
  // Pelo adapter real: 1000 x 5 + 200 x 15 = 8000 micro-reais; pelo sandbox: tokens x preço fixo de teste.
  const r = await new OpenAIAdapter(realCtx('openai', srv.baseUrl)).generate(pedido('m-gen', 'Olá'));
  assert.equal(r.costAmount, '0.008000');
  assert.deepEqual(r.usage, { tokensIn: 1000, tokensOut: 200 });
  const a = await new AnthropicAdapter(realCtx('anthropic', srv.baseUrl, { models: [modelo({ pricePerMTokIn: '2.5', pricePerMTokOut: '10' })] })).generate(pedido('m-gen', 'Olá'));
  assert.equal(a.costAmount, '0.004500');
  const sb = casos[0].make();
  const s = await sb.generate(pedido('sandbox-1', '[[ECO]] olá'));
  assert.equal(s.costAmount, microsToAmount(s.usage.tokensIn * 2 + s.usage.tokensOut * 6));
});

test('m9d010_embed_dimensoes_consistentes', async () => {
  for (const c of casos.filter((x) => x.embedModel)) {
    const um = await c.make().embed({ model: c.embedModel, inputs: ['alfa'] });
    const tres = await c.make().embed({ model: c.embedModel, inputs: ['alfa', 'beta gama', 'delta'] });
    assertEmbedShape(um, 1);
    assertEmbedShape(tres, 3);
    assert.equal(um.dimensions, tres.dimensions, `${c.name}: mesma dimensão em chamadas diferentes`);
  }
  // O fornecedor devolve menos vetores que entradas: erro, nunca vetor faltando.
  const oa = new OpenAIAdapter(realCtx('openai', srv.baseUrl));
  await assert.rejects(oa.embed({ model: 'm-emb', inputs: ['a [[EMBED_BAD]]', 'b'] }), (e) => e.kind === 'UNKNOWN');
  await assert.rejects(oa.embed({ model: 'm-emb', inputs: [] }), (e) => e.kind === 'VALIDATION');
});

test('m9d010_capabilities_devolve_lista_de_strings_e_models_devolve_catalogo', async () => {
  for (const c of casos) {
    const a = c.make();
    assert.ok(a instanceof IntegrationAdapter && a instanceof AiAdapter && a instanceof AIProviderAdapter, `${c.name} estende o contrato de integrações`);
    assert.ok(a.capabilities().every((x) => typeof x === 'string'));
    const info = validateAdapterClass(a.constructor);
    assert.deepEqual(info.capabilities, a.capabilities());
    assert.equal(info.domain, 'AI');
    assert.ok(a.models().length > 0);
    a.models().forEach((m) => {
      ['model', 'classe', 'generate', 'embed', 'transcribe', 'vision', 'maxInputTokens', 'maxOutputTokens', 'structuredOutput', 'toolUse', 'dataRetention', 'region', 'pricePerMTokIn', 'pricePerMTokOut', 'p95LatencyMs', 'safetyTier']
        .forEach((k) => assert.ok(k in m, `${c.name}/${m.model}: ${k}`));
    });
  }
  // Catálogo da conexão: linha inválida não entra (nunca presume um preço).
  const sujo = new OpenAIAdapter(realCtx('openai', srv.baseUrl, { models: [modelo(), modelo({ model: 'sem-preco', pricePerMTokIn: 'abc' })] }));
  assert.deepEqual(sujo.models().map((m) => m.model), ['m-gen']);
});
