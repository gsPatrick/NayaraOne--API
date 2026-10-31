'use strict';

// M9-D433 (reabertura M-1) — URL escrita no texto sem https:// literal: domínio solto, www., esquema relativo, esquema malformado e esquemas proibidos;
// portalUrl e unsubscribeUrl do envio; destino reconferido no clique. Postgres real (RLS), rollback. Só em banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const fx = require('../_helpers/m9d431Fixtures');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
require('../../../src/features/marketing'); // registra a regra única de URL externa no link rastreável
const security = require('../../../src/features/marketing/security');
const templates = require('../../../src/features/marketing/content/template.service');
const { templateInput } = require('../../helpers/m9d404Fixtures');
const tracking = require('../../../src/features/marketing/tracking').service;

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

const FORMAS = [
  ['dominio_solto_com_caminho', 'Entre em evil.com/login agora', 'evil.com/login'],
  ['dominio_solto_sem_caminho', 'Acesse evil.io hoje', 'evil.io'],
  ['www_sem_esquema', 'Veja www.evil.com/phish', 'www.evil.com/phish'],
  ['esquema_relativo', 'Clique em //evil.com/x', '//evil.com/x'],
  ['https_com_uma_barra', 'Clique https:/evil.com/x', 'https:/evil.com/x'],
  ['https_com_contrabarra', 'Clique https:\\\\evil.com/x', 'https:\\\\evil.com/x'],
  ['ftp', 'Baixe ftp://evil.com/a', 'ftp://evil.com/a'],
  ['file', 'Abra file:///etc/passwd', 'file:///etc/passwd'],
  ['javascript', 'Toque javascript:alert(1', 'javascript:alert(1'],
  ['http_literal', 'Veja http://evil.com/x', 'http://evil.com/x'],
];

test('toda_forma_de_url_no_texto_e_reconhecida_e_reprovada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await configurar(t);
    for (const [nome, texto, esperada] of FORMAS) {
      const bad = await security.findDisallowedUrls(texto, ctx(t));
      assert.equal(bad.length, 1, nome);
      assert.equal(bad[0].url, esperada, nome);
      assert.ok(bad[0].reasons.length > 0, nome);
      await assert.rejects(() => security.assertUrlsAllowed(texto, ctx(t)), (e) => e.statusCode === 422 && e.code === 'MKT_URL_NOT_ALLOWED', nome);
    }
    const motivos = async (texto) => (await security.findDisallowedUrls(texto, ctx(t)))[0].reasons;
    assert.deepEqual(await motivos('ftp://evil.com/a'), ['ESQUEMA_PROIBIDO']);
    assert.ok((await motivos('https:/evil.com/x')).includes('URL_MAL_FORMADA'));
    assert.ok((await motivos('www.evil.com')).includes('SO_HTTPS'));
    assert.ok((await motivos('www.nayara.com.br/x')).includes('SO_HTTPS'), 'domínio permitido sem https:// também não vale');
  });
});

test('texto_comum_nao_vira_url_e_o_https_permitido_passa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await configurar(t);
    const limpo = 'Preço 1.200,50 por m2, foto.jpg e Sr.Silva; fale com contato@nayara.com.br às 10:30. Veja https://nayara.com.br/imovel/12.';
    assert.deepEqual(await security.findDisallowedUrls(limpo, ctx(t)), []);
    assert.deepEqual(security.extractUrls(limpo), ['https://nayara.com.br/imovel/12']);
  });
});

test('terminacoes_reconhecidas_vem_do_parametro', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await configurar(t);
    assert.equal((await security.findDisallowedUrls('veja evil.zzz/x', ctx(t))).length, 0);
    await set(t, 'marketing.url.tlds_reconhecidos', 'zzz, com');
    assert.equal((await security.findDisallowedUrls('veja evil.zzz/x', ctx(t))).length, 1);
    for (const ruim of ['com, 1a', 'c.o.m', ' , ']) await assert.rejects(() => set(t, 'marketing.url.tlds_reconhecidos', ruim), (e) => e.code === 'MKT_PARAM_INVALID', ruim);
  });
});

test('template_com_url_sem_esquema_e_recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await configurar(t);
    for (const ruim of ['Veja www.evil.com/phish', 'Veja evil.com/login', 'Veja //evil.com']) {
      const input = templateInput({ body: ruim });
      await assert.rejects(() => templates.createTemplate(tenant, tenant.userId, input, t), (e) => e.code === 'MKT_URL_NOT_ALLOWED', ruim);
    }
  });
});

test('clique_reconfere_o_destino_e_recusa_dominio_que_saiu_da_lista', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await configurar(t);
    const lk = await tracking.createTrackingLink({ tenant, actor: tenant.userId, input: { targetUrl: 'https://portal.example.com/x', channel: 'EMAIL' } }, t);
    const click = () => tracking.resolveClick({ shortCode: lk.shortCode, session: { ip: '203.0.113.9', userAgent: 'QA-M9' }, transaction: t });
    assert.match((await click()).location, /^https:\/\/portal\.example\.com\/x/);
    await set(t, 'marketing.url.dominios_permitidos', 'outro.com.br');
    await assert.rejects(click, (e) => e.statusCode === 404, 'o domínio saiu da lista: o link deixa de redirecionar');
  });
});

test('portalUrl_e_unsubscribeUrl_do_envio_passam_pela_regra_de_url_externa', async () => {
  const env = require('../_helpers/mktMsgEnv');
  const { useTempSecretStore } = require('../_helpers/mktSecretStore');
  const off = useTempSecretStore();
  try {
    const { a: A } = await env.tenants();
    await withRollbackTenantTransaction(A, async (t) => {
      const p = await env.readyPerson(t, A);
      const base = (over) => ({ channel: 'EMAIL', personId: p, purpose: 'MARKETING', actionKey: env.key(), subject: 'Oi', text: 'Olá', unsubscribeUrl: 'https://www.exemplo.test/d?t=1', ...over });
      for (const over of [{ unsubscribeUrl: 'https://evil.example.org/d' }, { unsubscribeUrl: 'http://www.exemplo.test/d' }, { portalUrl: 'https://evil.example.org/p' }, { portalUrl: 'https://bit.ly/x' }]) {
        const input = base(over);
        await assert.rejects(() => env.send(t, A, input), (e) => e.statusCode === 422 && e.code === 'MKT_URL_NOT_ALLOWED', JSON.stringify(over));
        assert.equal(await env.byKey(t, A, input.actionKey), undefined, 'nada é gravado nem enviado');
      }
      assert.equal((await env.send(t, A, base({ portalUrl: 'https://portal.exemplo.test/seguro' }))).status, 'SENT');
    });
  } finally { off(); }
});
