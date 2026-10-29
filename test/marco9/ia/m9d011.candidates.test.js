'use strict';

// M9-D011 — candidates(): capability, política, criticidade, custo e latência, nessa ordem (função pura, sem banco).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rankCandidates } = require('../../../src/features/ai/providers/candidates');
const { linha, PARAMS, nomes } = require('../_helpers/iaCandidatos');

const rank = (entries, q, params = PARAMS) => rankCandidates(entries, { capabilities: ['generate'], ...q }, params);

test('m9d011_candidates_filtra_por_capability', () => {
  const entries = [
    linha('so-gera', {}, {}, ['generate']),
    linha('gera-e-embute', { model: 'emb', generate: false, embed: true, classe: 'EMBEDDING' }, {}, ['generate', 'embed']),
    // adapter declara embed, mas o modelo não faz: fora. Adapter sem a capability: fora, mesmo com o modelo capaz.
    linha('modelo-nao-faz', { embed: false }, {}, ['generate', 'embed']),
    linha('adapter-nao-declara', { embed: true, generate: false }, {}, ['generate']),
    linha('voz', { model: 'asr', generate: false, transcribe: true }, {}, ['transcribe']),
    linha('visao', { model: 'vis', generate: false, vision: true }, {}, ['analyzeImage']),
  ];
  assert.deepEqual(nomes(rank(entries, { capabilities: ['embed'] })), ['gera-e-embute/emb']);
  assert.deepEqual(nomes(rank(entries, { capabilities: ['transcribe'] })), ['voz/asr']);
  assert.deepEqual(nomes(rank(entries, { capabilities: ['analyzeImage'] })), ['visao/vis']);
  assert.deepEqual(nomes(rank(entries, { capabilities: ['generate'] })).sort(), ['modelo-nao-faz/modelo-nao-faz-m', 'so-gera/so-gera-m'].sort());
  // Várias capacidades exigidas ao mesmo tempo: o modelo precisa de todas.
  const multi = [linha('mm', { embed: true, generate: true }, {}, ['generate', 'embed']), linha('g', {}, {}, ['generate'])];
  assert.deepEqual(nomes(rank(multi, { capabilities: ['generate', 'embed'] })), ['mm/mm-m']);
  assert.deepEqual(rank([], { capabilities: ['generate'] }), []);
});

test('m9d011_candidates_ordena_por_custo_depois_latencia_depois_code', () => {
  const entries = [
    linha('b-caro', { pricePerMTokIn: 10, pricePerMTokOut: 30, p95LatencyMs: 100 }),
    linha('c-barato-lento', { pricePerMTokIn: 1, pricePerMTokOut: 3, p95LatencyMs: 900 }),
    linha('a-barato-rapido', { pricePerMTokIn: 1, pricePerMTokOut: 3, p95LatencyMs: 200 }),
    linha('z-igual', { pricePerMTokIn: 1, pricePerMTokOut: 3, p95LatencyMs: 200 }),
    linha('d-igual', { pricePerMTokIn: 1, pricePerMTokOut: 3, p95LatencyMs: 200 }),
  ];
  const lista = rank(entries, { requestSize: { tokensIn: 1000, tokensOut: 500 } });
  assert.deepEqual(lista.map((c) => c.providerCode), ['a-barato-rapido', 'd-igual', 'z-igual', 'c-barato-lento', 'b-caro']);
  // Custo estimado = entrada x preço de entrada + saída x preço de saída: 1000 x 1 + 500 x 3 = 2500 micro-reais.
  assert.equal(lista[0].estimatedCostMicros, 2500);
  assert.equal(lista[0].estimatedCost, '0.002500');
  assert.equal(lista[4].estimatedCost, '0.025000');
  // O tamanho do pedido pesa: um modelo com saída barata e entrada cara vira o mais barato num pedido de saída longa.
  const entradaCara = [linha('entrada-cara', { pricePerMTokIn: 20, pricePerMTokOut: 1 }), linha('saida-cara', { pricePerMTokIn: 1, pricePerMTokOut: 20 })];
  assert.equal(rank(entradaCara, { requestSize: { tokensIn: 10, tokensOut: 5000 } })[0].providerCode, 'entrada-cara');
  assert.equal(rank(entradaCara, { requestSize: { tokensIn: 5000, tokensOut: 10 } })[0].providerCode, 'saida-cara');
  // Orçamento de latência: p95 acima dele sai da lista.
  assert.deepEqual(rank(entries, { latencyBudgetMs: 250, requestSize: { tokensIn: 1000, tokensOut: 500 } }).map((c) => c.providerCode), ['a-barato-rapido', 'd-igual', 'z-igual', 'b-caro']);
  assert.deepEqual(rank(entries, { latencyBudgetMs: 50 }), []);
});

test('m9d011_candidates_aplica_politica_de_retencao_regiao_e_lab_only', () => {
  const entries = [
    linha('br-none', { dataRetention: 'NONE', region: 'BR' }),
    linha('us-30d', { dataRetention: '30D', region: 'US' }),
    linha('eu-padrao', { dataRetention: 'PROVIDER_DEFAULT', region: 'EU' }),
    linha('lab', { dataRetention: 'NONE', region: 'BR' }, { labOnly: true }),
    // A conexão (config_json) manda sobre o modelo: o contrato do cliente diz retenção NONE e região BR.
    linha('conexao-manda', { dataRetention: 'PROVIDER_DEFAULT', region: 'US' }, { dataRetention: 'NONE', region: 'BR' }),
  ];
  const so = (politica, params) => nomes(rank(entries, { politica }, params)).map((n) => n.split('/')[0]).sort();
  assert.deepEqual(so({ retentions: ['NONE'] }), ['br-none', 'conexao-manda', 'lab']);
  assert.deepEqual(so({ regions: ['BR'] }), ['br-none', 'conexao-manda', 'lab']);
  assert.deepEqual(so({ retentions: ['NONE', '30D'], regions: ['US'] }), ['us-30d']);
  assert.deepEqual(so({}), ['br-none', 'conexao-manda', 'eu-padrao', 'lab', 'us-30d']);
  // lab_only some em produção e volta fora dela.
  assert.deepEqual(so({}, { production: true, criticalMinSafetyTier: 2 }), ['br-none', 'conexao-manda', 'eu-padrao', 'us-30d']);
  // Classificação: CONFIDENTIAL só com allowsConfidential e contrato; RESTRICTED só com allowsRestricted e retenção NONE.
  const cls = [
    linha('livre'),
    linha('conf-sem-contrato', {}, { allowsConfidential: true }),
    linha('conf-ok', {}, { allowsConfidential: true, contractRef: 'CT-9' }),
    linha('restrito-30d', { dataRetention: '30D' }, { allowsRestricted: true }),
    linha('restrito-ok', { dataRetention: 'NONE' }, { allowsRestricted: true }),
  ];
  const por = (classification) => nomes(rank(cls, { politica: { classification } })).map((n) => n.split('/')[0]).sort();
  assert.deepEqual(por('PUBLIC'), ['conf-ok', 'conf-sem-contrato', 'livre', 'restrito-30d', 'restrito-ok']);
  assert.deepEqual(por('CONFIDENTIAL'), ['conf-ok']);
  assert.deepEqual(por('RESTRICTED'), ['restrito-ok']);
  assert.deepEqual(por('DESCONHECIDA'), ['restrito-ok'], 'classe desconhecida conta como RESTRICTED');
});

test('m9d011_candidates_agente_critico_exige_safety_tier_minimo', () => {
  const entries = [linha('t1', { safetyTier: 1 }), linha('t2', { safetyTier: 2 }), linha('t3', { safetyTier: 3 })];
  const por = (criticidade, params) => nomes(rank(entries, { criticidade }, params)).map((n) => n.split('/')[0]).sort();
  assert.deepEqual(por('NON_CRITICAL'), ['t1', 't2', 't3']);
  assert.deepEqual(por('CRITICAL'), ['t2', 't3'], 'piso padrão 2');
  assert.deepEqual(por('CRITICAL', { production: false, criticalMinSafetyTier: 3 }), ['t3'], 'o piso é parâmetro');
  assert.deepEqual(por('CRITICAL', { production: false, criticalMinSafetyTier: 1 }), ['t1', 't2', 't3']);
  assert.deepEqual(por(undefined), ['t1', 't2', 't3']);
});

test('m9d011_candidates_aplica_os_criterios_na_ordem_do_livro', () => {
  // Um candidato barato que falha em qualquer filtro nunca aparece; o mais barato que passa em todos vem primeiro.
  const entries = [
    linha('barato-sem-embed', { pricePerMTokIn: 0.1, embed: false }, {}, ['generate', 'embed']),
    linha('barato-us', { pricePerMTokIn: 0.2, embed: true, region: 'US' }, {}, ['generate', 'embed']),
    linha('barato-tier1', { pricePerMTokIn: 0.3, embed: true, safetyTier: 1 }, {}, ['generate', 'embed']),
    linha('barato-lento', { pricePerMTokIn: 0.4, embed: true, p95LatencyMs: 5000 }, {}, ['generate', 'embed']),
    linha('ok-caro', { pricePerMTokIn: 9, embed: true }, {}, ['generate', 'embed']),
    linha('ok-barato', { pricePerMTokIn: 1, embed: true }, {}, ['generate', 'embed']),
  ];
  const lista = rank(entries, { capabilities: ['embed'], criticidade: 'CRITICAL', politica: { regions: ['US'] }, latencyBudgetMs: 1000, requestSize: { tokensIn: 100, tokensOut: 0 } });
  assert.deepEqual(lista.map((c) => c.providerCode), ['barato-us', 'ok-barato', 'ok-caro']);
  assert.deepEqual(rank(entries, { capabilities: ['embed'], politica: { regions: ['BR'] } }), [], 'região BR exigida e todas as linhas são US');
});
