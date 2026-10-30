'use strict';

// M9-D433 — URL externa no link rastreável, no template e no conteúdo; ocorrência interna fora do alcance da IA. Postgres real (RLS), transação com rollback.
// Rodar em banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d433.conteudo.test.js
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const { templateInput } = require('../../helpers/m9d404Fixtures');
const fx = require('../_helpers/m9d431Fixtures');
const { factualResult } = require('../_helpers/mktFactualEnv');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const marketing = require('../../../src/features/marketing');
const tracking = require('../../../src/features/marketing/tracking').service;
const templates = require('../../../src/features/marketing/content/template.service');
const nay = require('../../../src/features/marketing/content/pipeline.nayPort');
const { assertContentServiceSources } = require('../../../src/features/marketing/content/internalSourceGuard');
const { factCheckFailed } = require('../../../src/features/marketing/content/pipeline.errors');
const path = require('node:path');

let tenant;
let cleanup;
before(async () => { ({ tenantA: tenant } = await prepararTenants()); cleanup = fx.useTempSecretStore(); });
after(async () => { cleanup(); await sequelize.close(); });
afterEach(() => nay.clearNayDraftProvider());
const recusa = (code) => (e) => e.statusCode === 422 && e.code === code && /[a-zà-ú]/i.test(e.message);
const set = (t, key, value) => upsertSetting(key, value, tenant, tenant.userId, t);
/** Allowlist da empresa para os testes; a verificação de DNS/redirecionamento fica desligada (sem rede), por parâmetro. */
async function configurar(t) {
  await set(t, 'marketing.url.dominios_permitidos', 'nayara.com.br, portal.example.com');
  await set(t, 'marketing.url.verificar_destino', false);
}
const link = (t, targetUrl) => tracking.createTrackingLink({ tenant, actor: tenant.userId, input: { targetUrl, channel: 'EMAIL' } }, t);

test('tracking_link_com_url_invalida_recusado', async () => {
  assert.ok(marketing.security, 'a fachada do Marketing registra a regra única de URL externa');
  await withRollbackTenantTransaction(tenant, async (t) => {
    await configurar(t);
    for (const ruim of ['http://nayara.com.br/x', 'https://bit.ly/x', 'https://10.0.0.5/x', ['https://usuario', 'x@nayara.com.br/x'].join(':'), 'https://outro-dominio.com/x']) {
      await assert.rejects(() => link(t, ruim), recusa('MKT_URL_NOT_ALLOWED'), ruim);
    }
    const ok = await link(t, 'https://nayara.com.br/imovel/1234');
    assert.match(ok.shortCode, /^[A-Z0-9]+$/);
  });
});

test('dominios_permitidos_e_o_dominio_da_empresa_vem_do_parametro: mudar o parametro muda o efeito', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await set(t, 'marketing.url.verificar_destino', false);
    await set(t, 'marketing.url.dominios_permitidos', 'nenhum');
    await assert.rejects(() => link(t, 'https://nayara.com.br/x'), recusa('MKT_URL_NOT_ALLOWED'), 'sem domínio da empresa nem permitido, nada passa');
    await set(t, 'marketing.seo.url_base', 'https://www.nayara.com.br');
    assert.ok(await link(t, 'https://nayara.com.br/x'), 'o domínio do site (URL base do SEO) vale sem repetir configuração');
    await set(t, 'marketing.url.dominios_permitidos', 'portal.example.com');
    assert.ok(await link(t, 'https://anuncio.portal.example.com/a'), 'portal homologado');
    await assert.rejects(() => set(t, 'marketing.url.dominios_permitidos', 'nao é domínio'), (e) => e.code === 'MKT_PARAM_INVALID');
    await set(t, 'marketing.url.max_comprimento', 64);
    await assert.rejects(() => link(t, `https://nayara.com.br/${'a'.repeat(80)}`), recusa('MKT_URL_NOT_ALLOWED'), 'o tamanho máximo é o do parâmetro');
  });
});

test('template_com_url_fora_da_regra_e_recusado_e_com_url_permitida_passa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await configurar(t);
    const body = (url) => `Veja o imóvel em {{bairro}}: ${url}`;
    await assert.rejects(() => templates.createTemplate(tenant, tenant.userId, templateInput({ body: body('http://nayara.com.br/x') }), t), recusa('MKT_URL_NOT_ALLOWED'));
    await assert.rejects(() => templates.createTemplate(tenant, tenant.userId, templateInput({ body: body('https://bit.ly/abc') }), t), recusa('MKT_URL_NOT_ALLOWED'));
    const ok = await templates.createTemplate(tenant, tenant.userId, templateInput({ body: body('https://nayara.com.br/imovel') }), t);
    assert.equal(ok.status, 'DRAFT');
  });
});

test('conteudo_com_url_externa_nao_permitida_vai_para_fact_check_failed', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await configurar(t);
    const bom = await factualResult(t, tenant, 'Casa de 3 quartos. Detalhes em https://nayara.com.br/imovel/1');
    assert.equal(bom.status, 'FACT_CHECKED');
    const ruim = await factualResult(t, tenant, 'Casa de 3 quartos. Detalhes em http://bit.ly/oferta');
    assert.equal(ruim.status, 'FACT_CHECK_FAILED');
    const f = ruim.findings.find((x) => x.reason === 'URL_NOT_ALLOWED');
    assert.ok(f && f.claim === 'http://bit.ly/oferta');
    const err = factCheckFailed(ruim.findings, {});
    assert.equal(err.code, 'MKT_URL_NOT_ALLOWED');
  });
});

test('ia_nao_publica_ocorrencia_interna', async () => {
  // (1) a NAY de conteúdo só recebe os fatos públicos: nenhuma ferramenta lê ocorrência, e o código do serviço de conteúdo não toca tabela de origem
  assert.equal(assertContentServiceSources(path.join(__dirname, '..', '..', '..', 'src', 'features', 'marketing', 'content')), true);
  // (2) a varredura de saída barra o texto que cita ocorrência/reclamação interna, com os termos vindos do parâmetro
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ok = await factualResult(t, tenant, 'Casa de 3 quartos em bairro tranquilo.');
    assert.equal(ok.status, 'FACT_CHECKED');
    for (const texto of ['Casa de 3 quartos. Houve ocorrência de vazamento no ano passado.', 'Casa de 3 quartos. Cliente fez reclamação sobre o telhado.', 'Casa de 3 quartos. Anotação interna: pendência com o vizinho.']) {
      const r = await factualResult(t, tenant, texto);
      assert.equal(r.status, 'FACT_CHECK_FAILED', texto);
      assert.ok(r.findings.some((f) => f.kind === 'INTERNAL_REFERENCE' && f.reason === 'INTERNAL_REFERENCE' && f.severity === 'BLOCK'), texto);
      assert.equal(factCheckFailed(r.findings, {}).code, 'MKT_INTERNAL_REFERENCE');
    }
    const antes = await factualResult(t, tenant, 'Casa de 3 quartos. A infiltração no teto foi resolvida.');
    assert.equal(antes.status, 'FACT_CHECKED', 'sem o termo na lista, o texto passa');
    await set(t, 'marketing.factual.termos_internos', 'infiltração, ocorrência');
    const depois = await factualResult(t, tenant, 'Casa de 3 quartos. A infiltração no teto foi resolvida.');
    assert.equal(depois.status, 'FACT_CHECK_FAILED', 'o administrador define os termos');
    await assert.rejects(() => set(t, 'marketing.factual.termos_internos', '   '), (e) => e.statusCode === 400);
  });
});
