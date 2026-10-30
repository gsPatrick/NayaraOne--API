'use strict';

// M9-D427 regra 5 — blog educativo (EDUCATIONAL_BLOG): fontes registradas e permitidas, parágrafo factual com referência [n] e qualidade mínima.
// A parte pura roda sem banco; a parte do pipeline e dos parâmetros roda em Postgres real (transação com rollback).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { getSeedTenant, withRollbackTenantTransaction } = require('../../testHelpers');
const blog = require('../../../src/features/marketing/content/blog');
const { createAndRun } = require('../../../src/features/marketing/content/content.service');
const { factCheckFailed } = require('../../../src/features/marketing/content/pipeline.errors');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let A;
before(async () => { A = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const CONFIG = { allowedDomains: ['gov.br', 'ibge.gov.br', 'bcb.gov.br'], minWords: 30, aiNotice: 'Conteúdo gerado com apoio de inteligência artificial' };
const FONTE = 'https://www.ibge.gov.br/estatisticas/pesquisas | 2026-10-12';
const filler = (n) => Array.from({ length: n }, (_, i) => `palavra${String.fromCharCode(97 + (i % 26))}`).join(' ');
const GOOD = `Comprar o primeiro imóvel exige planejamento e calma ao longo de todo o processo de escolha. ${filler(30)}\n\nO IBGE mostra que a taxa de crescimento da população urbana subiu 3,2% no último levantamento [1]. ${filler(10)}`;

const codes = (result) => [...new Set(result.findings.map((f) => f.code))];
const reasons = (result) => result.findings.map((f) => f.reason);

test('blog_ia_exige_fontes_e_qualidade_minima', () => {
  assert.equal(blog.checkBlog({ texto: GOOD, fontes: [FONTE] }, CONFIG).ok, true);
  const semFonte = blog.checkBlog({ texto: GOOD, fontes: [] }, CONFIG);
  assert.deepEqual([semFonte.ok, codes(semFonte)], [false, ['MKT_BLOG_SOURCES_REQUIRED']]);
  assert.ok(reasons(semFonte).includes('NO_SOURCES'));
  assert.deepEqual(codes(blog.checkBlog({ texto: GOOD }, CONFIG)), ['MKT_BLOG_SOURCES_REQUIRED'], 'campo ausente também é "sem fonte"');
  // fonte sem data de acesso ou com URL inválida não vale
  assert.ok(reasons(blog.checkBlog({ texto: GOOD, fontes: ['https://www.ibge.gov.br/x'] }, CONFIG)).includes('ACCESS_DATE_INVALID'));
  assert.ok(reasons(blog.checkBlog({ texto: GOOD, fontes: ['isto nao e url | 2026-10-12'] }, CONFIG)).includes('URL_INVALID'));
  assert.ok(reasons(blog.checkBlog({ texto: GOOD, fontes: ['https://www.ibge.gov.br/x | 2026-02-31'] }, CONFIG)).includes('ACCESS_DATE_INVALID'));
  // qualidade: poucas palavras
  const curto = blog.checkBlog({ texto: 'Texto curtíssimo sem números nem leis.', fontes: [FONTE] }, CONFIG);
  assert.deepEqual([curto.ok, codes(curto), curto.findings[0].reason, curto.findings[0].expected], [false, ['MKT_BLOG_QUALITY_FAILED'], 'TOO_SHORT', 30]);
  // gerado pela NAY: exige o aviso de apoio de IA
  const nay = blog.checkBlog({ texto: GOOD, fontes: [FONTE], nayGenerated: true }, CONFIG);
  assert.deepEqual([codes(nay), reasons(nay)], [['MKT_BLOG_QUALITY_FAILED'], ['AI_NOTICE_MISSING']]);
  assert.equal(blog.checkBlog({ texto: `${GOOD}\n\n${CONFIG.aiNotice}.`, fontes: [FONTE], nayGenerated: true }, CONFIG).ok, true);
});

test('paragrafo_com_numero_sem_referencia_bloqueia_o_blog', () => {
  const casos = {
    numero: 'A procura por apartamentos cresceu 12 vezes nos últimos tempos e segue em alta no mercado.',
    percentual: 'O percentual de financiamento sobe por cento a cada trimestre segundo o mercado.',
    reais: 'Muitos compradores gastam mil reais por mês com a taxa de condomínio do imóvel.',
    data: 'A regra mudou em março de 2024 para todos os contratos novos de locação residencial.',
    lei: 'A Lei do Inquilinato regula os contratos de locação de imóveis urbanos no país inteiro.',
    norma: 'A LGPD obriga a empresa a pedir consentimento antes de tratar os dados do cliente.',
  };
  for (const [nome, paragrafo] of Object.entries(casos)) {
    const sem = blog.checkBlog({ texto: `${filler(35)}\n\n${paragrafo}`, fontes: [FONTE] }, CONFIG);
    assert.equal(sem.ok, false, `${nome} sem referência deve bloquear`);
    assert.deepEqual(codes(sem), ['MKT_BLOG_SOURCES_REQUIRED']);
    assert.equal(sem.findings[0].reason, 'PARAGRAPH_WITHOUT_SOURCE');
    assert.equal(sem.findings[0].paragraph, 2);
    assert.equal(blog.checkBlog({ texto: `${filler(35)}\n\n${paragrafo} [1]`, fontes: [FONTE] }, CONFIG).ok, true, `${nome} com [1] passa`);
  }
  // referência para item que não existe não vale; o número dentro de [n] não é afirmação
  const inexistente = blog.checkBlog({ texto: `${filler(35)}\n\nO índice subiu 5% no ano [2].`, fontes: [FONTE] }, CONFIG);
  assert.equal(inexistente.findings[0].reason, 'REFERENCE_UNKNOWN');
  assert.equal(blog.checkBlog({ texto: `${filler(35)}\n\nTexto sem afirmação factual nenhuma, só orientação geral ao leitor [1].`, fontes: [FONTE] }, CONFIG).ok, true);
  // título com número não conta como parágrafo factual
  assert.equal(blog.checkBlog({ texto: `## 5 dicas para comprar\n\n${filler(35)}`, fontes: [FONTE] }, CONFIG).ok, true);
});

test('fonte_fora_da_lista_de_dominios_permitidos_bloqueia', async () => {
  const fora = blog.checkBlog({ texto: GOOD, fontes: ['https://blog-qualquer.com.br/post | 2026-10-12'] }, CONFIG);
  assert.deepEqual([fora.ok, codes(fora), reasons(fora)[0]], [false, ['MKT_BLOG_SOURCES_REQUIRED'], 'DOMAIN_NOT_ALLOWED']);
  // domínio parecido não engana: igualdade ou subdomínio
  assert.ok(reasons(blog.checkBlog({ texto: GOOD, fontes: ['https://falso-ibge.gov.br.evil.com/x | 2026-10-12'] }, CONFIG)).includes('DOMAIN_NOT_ALLOWED'));
  assert.equal(blog.checkBlog({ texto: GOOD, fontes: ['https://servicodados.ibge.gov.br/api | 2026-10-12'] }, CONFIG).ok, true, 'subdomínio vale');
  // a lista é parâmetro da empresa; os domínios da própria empresa somam; lista vazia é recusada na escrita
  await withRollbackTenantTransaction(A, async (t) => {
    assert.deepEqual((await blog.readBlogConfig(A, t)).allowedDomains, ['gov.br', 'ibge.gov.br', 'bcb.gov.br', 'caixa.gov.br', 'cnj.jus.br']);
    await upsertSetting('marketing.blog.dominios_empresa', 'Nayara.com.br', A, A.userId, t);
    await upsertSetting('marketing.blog.fontes_permitidas', 'bcb.gov.br', A, A.userId, t);
    assert.deepEqual((await blog.readBlogConfig(A, t)).allowedDomains, ['bcb.gov.br', 'nayara.com.br']);
    for (const bad of ['', 'nenhum', ' , ', 'sem espaço.com']) {
      await assert.rejects(() => upsertSetting('marketing.blog.fontes_permitidas', bad, A, A.userId, t), (e) => ['MKT_PARAM_INVALID', 'SETTING_INVALID_VALUE'].includes(e.code), `valor ${JSON.stringify(bad)}`);
    }
    await upsertSetting('marketing.blog.min_palavras', 12, A, A.userId, t);
    assert.equal((await blog.readBlogConfig(A, t)).minWords, 12);
  });
});

test('blog_no_pipeline_bloqueia_sem_fonte_e_a_revisao_preserva_as_fontes', async () => {
  const run = (input, t) => createAndRun({ tenant: A, actor: A.userId, input }, (fn) => fn(t));
  await withRollbackTenantTransaction(A, async (t) => {
    await upsertSetting('marketing.blog.min_palavras', 30, A, A.userId, t);
    // sem nenhuma fonte o artigo nem entra: 422 MKT_BLOG_SOURCES_REQUIRED (e nada é gravado)
    await assert.rejects(() => run({ type: 'EDUCATIONAL_BLOG', tema: 'Primeiro imóvel', texto: GOOD }, t),
      (e) => e.statusCode === 422 && e.code === 'MKT_BLOG_SOURCES_REQUIRED' && e.message === 'O artigo precisa citar fontes permitidas.');
    // fonte de domínio não permitido entra como rascunho reprovado, com o mesmo código
    const semFonte = await run({ type: 'EDUCATIONAL_BLOG', tema: 'Primeiro imóvel', texto: GOOD, fontes: ['https://blog-qualquer.com.br/post | 2026-10-12'] }, t);
    assert.equal(semFonte.content.status, 'FACT_CHECK_FAILED');
    const erro = factCheckFailed(semFonte.content.findings, {});
    assert.deepEqual([erro.statusCode, erro.code, erro.message], [422, 'MKT_BLOG_SOURCES_REQUIRED', 'O artigo precisa citar fontes permitidas.']);
    // revisar com as fontes corrige: o mesmo item avança e as fontes seguem nas versões seguintes
    const corrigido = await run({ contentItemId: semFonte.content.id, texto: GOOD, fontes: [FONTE] }, t);
    assert.notEqual(corrigido.content.status, 'FACT_CHECK_FAILED', JSON.stringify(corrigido.content.findings));
    const curto = await run({ type: 'EDUCATIONAL_BLOG', tema: 'Curto', texto: 'Texto curto demais.', fontes: [FONTE] }, t);
    const erroQualidade = factCheckFailed(curto.content.findings, {});
    assert.deepEqual([erroQualidade.statusCode, erroQualidade.code, erroQualidade.message], [422, 'MKT_BLOG_QUALITY_FAILED', 'O artigo falhou na verificação de qualidade.']);
    const revisado = await run({ contentItemId: curto.content.id, texto: GOOD }, t); // sem repetir as fontes: elas vêm da versão anterior
    assert.notEqual(revisado.content.status, 'FACT_CHECK_FAILED', JSON.stringify(revisado.content.findings));
  });
});
