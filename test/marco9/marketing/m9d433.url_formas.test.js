'use strict';

// M9-D433 (reabertura da rodada 2: M-1, M-2, M-3, L-1 a L-4) — o reconhecimento de URL no texto não depende de lista fechada de terminações, cobre o blog, o título e o corpo
// renderizado, e não reprova texto legítimo (e-mail, palavra colada, domínio da própria empresa). A parte pura roda sem banco; o resto em Postgres real (rollback).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const { factualResult } = require('../_helpers/mktFactualEnv');
const fx = require('../_helpers/m9d431Fixtures');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const security = require('../../../src/features/marketing/security');
const { DEFAULT_TLDS } = require('../../../src/features/marketing/security/url.settings');
const { createAndRun } = require('../../../src/features/marketing/content/content.service');

let tenant;
let cleanup;
before(async () => { ({ tenantA: tenant } = await prepararTenants()); cleanup = fx.useTempSecretStore(); });
after(async () => { cleanup(); await sequelize.close(); });
const set = (t, key, value) => upsertSetting(key, value, tenant, tenant.userId, t);
async function configurar(t) {
  await set(t, 'marketing.url.dominios_permitidos', 'nayara.com.br, portal.example.com');
  await set(t, 'marketing.url.verificar_destino', false);
}
const ctx = (t) => ({ tenant, transaction: t });
const hostis = async (t, texto) => (await security.findDisallowedUrls(texto, ctx(t))).map((b) => b.url);

const COM_CAMINHO = ['evil.in/login', 'evil.fr/x', 'evil.es/x', 'evil.it/x', 'evil.ng/x', 'evil.ninja/x', 'evil.zip/x', 'evil.mov/x', 'evil.gov/x', 'evil.edu/x', 'evil.museum/x', 'evil.xn--p1ai/x',
  'evil.рф/x', 'пример.рф/x', 'a.b.evil.sbs#frag'];
// Terminação fora da lista (rodada 5, fail-to-review): é reconhecida como candidato, mas vai à revisão humana em vez de bloquear.
const SO_REVISAO = ['evil.qualquercoisa/login', 'evil.zzzz/x'];

test('terminacao_qualquer_com_caminho_e_reconhecida_sem_lista', () => {
  for (const url of [...COM_CAMINHO, ...SO_REVISAO]) assert.deepEqual(security.extractUrls(`Entre em ${url} agora`, { tlds: ['com'] }), [url], url);
});

test('endereco_pelado_usa_a_lista_ampliada_de_terminacoes', () => {
  for (const tld of ['in', 'fr', 'zip', 'mov', 'ninja', 'gov', 'edu', 'рф', 'sbs', 'cfd', 'rest', 'bond']) assert.ok(DEFAULT_TLDS.includes(tld), tld);
  for (const url of ['evil.fr', 'evil.zip', 'evil.gov', 'evil.рф', 'evil.ninja']) assert.deepEqual(security.extractUrls(`Acesse ${url} hoje`), [url], url);
});

test('formas_disfarcadas_sao_normalizadas_e_reconhecidas (L-4)', () => {
  const casos = [['evil。com/login', 'evil.com/login'], ['evil．com/login', 'evil.com/login'], ['ｅｖｉｌ.com/x', 'evil.com/x'], ['evil.​com/login', 'evil.com/login'], ['https:evil.com', 'https:evil.com'],
    ['http:evil.com', 'http:evil.com'], ['1.2.3.4/x', '1.2.3.4/x'], ['http://10.0.0.5/a', 'http://10.0.0.5/a'], ['hxxps://evil.com', 'hxxps://evil.com']];
  for (const [entrada, esperada] of casos) assert.deepEqual(security.extractUrls(`Clique ${entrada} já`), [esperada], entrada);
});

test('texto_legitimo_nao_vira_url (L-1, L-2)', () => {
  const legitimos = ['maria.pro@nayara.com.br', 'jose.me@x.com', 'ana.co@x.com', 'ana.to@nayara.com.br', 'tel.app@x.com', 'Preço R$ 1.000,00 em 10.12.2026',
    'pi 3.14 e v1.2.3', 'e/ou km/h', 'versão 1.2.3.4x'];
  for (const texto of legitimos) assert.deepEqual(security.extractUrls(texto), [], texto);
});

test('hostil_e_reprovada_e_legitimo_passa_com_banco: domínio da própria empresa sem https:// vale (L-3)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await configurar(t);
    for (const url of COM_CAMINHO) assert.deepEqual(await hostis(t, `Veja ${url}`), [url], url);
    for (const url of SO_REVISAO) assert.deepEqual(await security.findReviewUrls(`Veja ${url}`, ctx(t)), [url], url);
    for (const ok of ['Acesse www.nayara.com.br', 'Veja nayara.com.br/imovel/1', 'Portal: anuncio.portal.example.com/a', 'Escreva para maria.pro@nayara.com.br', 'Av.Paulista/Centro e foto.jpg']) {
      assert.deepEqual(await hostis(t, ok), [], ok);
    }
    for (const ruim of ['www.nayara.com.br.evil.com/x', 'nayara.com.br@evil.com/x', 'evil.com/nayara.com.br', '//nayara.com.br/x', 'ftp://nayara.com.br/x', 'nayara.com.br:8080@evil.com']) {
      assert.ok((await hostis(t, ruim)).length >= 1, ruim);
    }
  });
});

const BLOG = (extra) => `Comprar o primeiro imóvel exige planejamento e calma ao longo de todo o processo de escolha do lar ideal para a família. ${'palavra '.repeat(40)}\n\n${extra} [1]`;
const FONTE = 'https://www.ibge.gov.br/estatisticas/pesquisas | 2026-10-12';

test('blog_educativo_passa_pela_regra_de_url (M-1)', async () => {
  const run = (texto, t) => createAndRun({ tenant, actor: tenant.userId, input: { type: 'EDUCATIONAL_BLOG', tema: 'Primeiro imóvel', texto, fontes: [FONTE] } }, (fn) => fn(t));
  await withRollbackTenantTransaction(tenant, async (t) => {
    await configurar(t);
    await set(t, 'marketing.blog.min_palavras', 30);
    const bom = await run(BLOG('Veja mais no site em https://nayara.com.br/blog/guia'), t);
    assert.equal(bom.content.status, 'PENDING_APPROVAL', JSON.stringify(bom.content.findings));
    for (const ruim of ['Acesse https://evil.com/login agora', 'Acesse evil.com/login agora', 'Acesse evil.fr/login agora', 'Toque javascript:alert(1)']) {
      const r = await run(BLOG(ruim), t);
      assert.equal(r.content.status, 'FACT_CHECK_FAILED', ruim);
      assert.ok(r.content.findings.some((f) => f.reason === 'URL_NOT_ALLOWED'), ruim);
    }
  });
});

test('titulo_e_corpo_renderizado_passam_pela_regra_de_url (M-2)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await configurar(t);
    const limpo = await factualResult(t, tenant, 'Casa de 3 quartos em bairro tranquilo.', undefined, { title: 'Casa nova no centro', body: { renderizado: 'Casa nova. Veja https://nayara.com.br/imovel/1' } });
    assert.equal(limpo.status, 'FACT_CHECKED', JSON.stringify(limpo.findings));
    const casos = [['Acesse https://evil.com/login', {}], ['Acesse evil.com/login', {}], ['Casa nova', { renderizado: 'Visite evil.com/login' }], ['Casa nova', { renderizado: 'Visite https://bit.ly/x' }]];
    for (const [title, body] of casos) {
      const r = await factualResult(t, tenant, 'Casa de 3 quartos em bairro tranquilo.', undefined, { title, body });
      assert.equal(r.status, 'FACT_CHECK_FAILED', `${title} ${JSON.stringify(body)}`);
      assert.ok(r.findings.some((f) => f.kind === 'URL' && f.reason === 'URL_NOT_ALLOWED'));
    }
  });
});

test('variavel_do_pedido_com_url_hostil_nao_chega_ao_corpo_renderizado', async () => {
  const fx6 = require('../../helpers/m9d406Fixtures');
  const service = require('../../../src/features/marketing/content/content.service');
  const { draftWithFacts } = require('../_helpers/mktFactualEnv');
  await withRollbackTenantTransaction(tenant, async (t) => {
    await configurar(t);
    const tpl = await fx6.publishedTemplate(t, tenant);
    const { itemId } = await draftWithFacts(t, tenant, 'Casa de 3 quartos em bairro tranquilo.');
    await service.runFactualCheck({ tenant, actor: tenant.userId, itemId }, t);
    const nomes = String(tpl.body || '').match(/{{\s*([\w.]+)\s*}}/g) || [];
    assert.ok(nomes.length > 0, 'o template de teste tem variável');
    const variables = Object.fromEntries(nomes.map((n) => [n.replace(/[{}\s]/g, ''), 'Veja evil.com/login']));
    await assert.rejects(() => service.applyTemplate({ tenant, actor: tenant.userId, itemId, templateId: tpl.id, variables }, t), (e) => e.statusCode === 422 && e.code === 'MKT_URL_NOT_ALLOWED');
  });
});
