'use strict';

// M9-D433 (rodada 5, fail-to-review) — suíte permanente gerada: tabelas hostis, ambíguas e legítimas (test/marco9/_helpers/urlCorpus.js) mais os casos nomeados da auditoria
// (arroba no caminho, marca combinante, terminação IDN, preço, resíduos sem esquema). Pura, sem banco: a configuração vem do corpus.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const security = require('../../../src/features/marketing/security');
const corpus = require('../_helpers/urlCorpus');

const { config } = corpus;
const ctx = { config, origin: 'SYSTEM' };
const blocked = async (text) => (await security.findDisallowedUrls(text, ctx)).map((b) => b.url);
const review = (text) => security.findReviewUrls(text, ctx);

test('tabela_hostil_gerada_e_literal_bloqueia_em_todas_as_formas', async () => {
  const todos = [...corpus.generatedHostile(), ...corpus.HOSTILE_LITERAL];
  assert.ok(todos.length > 350, 'a tabela gerada cobre centenas de formas');
  const furos = [];
  for (const text of todos) if ((await blocked(text)).length === 0) furos.push(text.slice(0, 70));
  assert.deepEqual(furos, []);
});

test('tabela_ambigua_nunca_bloqueia_e_sempre_vai_a_revisao', async () => {
  for (const item of corpus.AMBIGUOUS) {
    const text = `Veja ${item} hoje`;
    assert.deepEqual(await blocked(text), [], `${item}: não pode bloquear por heurística`);
    assert.ok((await review(text)).length >= 1, `${item}: precisa ir à revisão humana`);
  }
});

test('tabela_legitima_e_preco_nao_bloqueiam_nem_vao_a_revisao (M-4)', async () => {
  for (const item of corpus.LEGITIMATE) {
    const text = `Veja ${item} hoje`;
    assert.deepEqual(await blocked(text), [], item);
    assert.deepEqual(await review(text), [], item);
  }
  for (const item of corpus.PRICES) assert.deepEqual(security.extractCandidates(item), [], item);
});

test('arroba_depois_de_um_caminho_nao_e_email (M-1)', async () => {
  for (const url of ['evil.com/login@x', 'evil.com/p@ss', 'evil.com/a?u=b@c', 'www.evil.com/a@b']) {
    assert.deepEqual(security.extractUrls(`Veja ${url} agora`), [url], url);
    assert.deepEqual(await blocked(`Veja ${url} agora`), [url], url);
  }
  assert.deepEqual(security.extractCandidates('Escreva para maria.pro@nayara.com.br ou jose.me@x.com'), [], 'e-mail de verdade continua fora');
});

test('marca_combinante_e_terminacao_idn_real_nao_escapam (M-2)', async () => {
  for (const url of ['evil̀.com/login', 'x́.com/p', 'evil.भारत', 'evil.বাংলা/x', 'evil.ਭਾਰਤ', 'evil.ભારત', 'evil.భారత్', 'evil.ಭಾರತ', 'evil.ഭാരതം', 'evil.ලංකා', 'evil.ଭାରତ', 'evil.संगठन', 'evil.சிங்கப்பூர்', 'evil.भारतम्', 'evil.भारोत', 'evil.कॉम', 'evil.नेट', 'evil.ভারত']) {
    assert.deepEqual(await blocked(`Acesse ${url} hoje`), [url], url);
  }
});

test('preco_numero_legal_e_fracao_nunca_viram_endereco (M-4)', async () => {
  for (const text of ['Aluguel R$ 2.000/mês', 'R$ 3.000/mês', 'R$ 10.000/mês', 'R$ 1.000/m²', 'R$ 5.000/m²', 'IPTU 1.045/ano', '0.5/1']) {
    assert.deepEqual(security.extractCandidates(text), [], text);
  }
  assert.deepEqual(security.extractCandidates('Veja 127.1/x').map((c) => c.kind), ['HOSTILE'], 'a própria máquina em forma curta continua hostil');
});

test('residuos_sem_esquema_sao_recusados (L-5)', async () => {
  for (const text of ['Veja //[::1]/x', 'Veja //@evil.com', 'Veja nayara.com.br@evil.com', 'Veja 1.2.3.4']) assert.ok((await blocked(text)).length >= 1, text);
  assert.deepEqual(await blocked('Escreva para ana@nayara.com.br'), [], 'e-mail da própria empresa');
});

test('terminacao_conhecida_em_punycode_e_comparada_pela_forma_unicode', async () => {
  assert.equal((await blocked('Veja evil.xn--p1ai')).length, 1);
  assert.equal((await blocked('Veja evil.рф')).length, 1);
});

test('tetos_de_tamanho_array_gigante_responde_422_e_nunca_500 (L-3)', async () => {
  const limits = { maxVariable: 2000, maxField: 20000, maxTotal: 100000, blockReview: true };
  for (const variables of [{ a: new Array(130000).fill('a') }, { a: new Array(2000000).fill('') }, { a: 'x'.repeat(2001) }, { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 'x' } } } } } } } } } }]) {
    await assert.rejects(() => security.assertTextSizes([], variables, { tenant: {}, limits }), (e) => e.statusCode === 422 && e.code === 'MKT_URL_NOT_ALLOWED');
    await assert.rejects(() => security.assertTextFieldsSafe([], variables, { tenant: {}, limits, config }), (e) => e.statusCode === 422 && e.code === 'MKT_URL_NOT_ALLOWED');
  }
});
