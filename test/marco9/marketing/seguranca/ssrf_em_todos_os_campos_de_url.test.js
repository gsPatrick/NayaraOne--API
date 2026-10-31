'use strict';

// M9-D441 segurança 4 (Caderno §14): SSRF e URL maliciosa em TODOS os campos de URL do Marketing. Cada campo (link rastreável, template, texto do conteúdo, URL de avaliação e link da pesquisa
// de satisfação) recusa a mesma lista de endereços perigosos (sem https, IP e rede interna, metadados de nuvem, localhost, esquemas file/javascript, credencial na URL, encurtador,
// domínio fora da allowlist), e aceita a URL boa de controle. Sem rede: DNS e redirecionamento ficam desligados e a allowlist vem do parâmetro. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('../../../../src/features/marketing'); // registra o validador único de URL externa nas portas
const { sequelize } = require('../../../../src/models');
const { withRollbackTenantTransaction } = require('../../../testHelpers');
const { prepararTenants } = require('../../../helpers/marketingExecucao');
const { templateInput } = require('../../../helpers/m9d404Fixtures');
const fx = require('../../_helpers/m9d431Fixtures');
const { allowTestUrls } = require('../../_helpers/mktUrlPolicy');
const { factualResult } = require('../../_helpers/mktFactualEnv');
const tracking = require('../../../../src/features/marketing/tracking').service;
const templates = require('../../../../src/features/marketing/content/template.service');
const { upsertSetting } = require('../../../../src/features/settings/settings.service');
const { surveyLink } = require('../../../../src/features/marketing/automations/seeds/surveyLink');

let tenant;
let cleanup;
before(async () => { ({ tenantA: tenant } = await prepararTenants()); cleanup = fx.useTempSecretStore(); });
after(async () => { cleanup(); await sequelize.close(); });

const CREDENCIAL = ['https://usuario', 'senha@exemplo.test/x'].join(':'); // montada na hora: o varredor de segredos não pode ver a credencial na URL
const BOA = 'https://exemplo.test/imovel/1234';
// URLs http/https perigosas: valem para todos os campos (as de texto e as de campo único)
const PERIGOSAS_WEB = [
  'http://exemplo.test/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data/', 'https://localhost/x', 'https://[::1]/x', 'https://10.0.0.5/x', 'https://192.168.0.10/x',
  'https://172.16.0.1/x', 'https://2130706433/x', 'https://0x7f000001/x', 'https://servidor.interno.internal/x', 'https://exemplo.test.malicioso.example/x', 'https://outro-site.example/x',
  'https://bit.ly/abc', 'https://tinyurl.com/abc', CREDENCIAL, 'https://exemplo.test@malicioso.example/x',
];
// esquemas que não são http/https só podem entrar em campo de URL único (num texto livre não são links)
const PERIGOSAS_ESQUEMA = ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://exemplo.test/x', 'gopher://127.0.0.1:25/x', 'data:text/html,<script>alert(1)</script>'];

const emTransacao = (fn) => withRollbackTenantTransaction(tenant, async (t) => { await allowTestUrls(t, tenant); return fn(t); });
const recusada = (e) => e && (e.statusCode === 422 || e.statusCode === 400) && /URL|MKT_/i.test(`${e.code} ${e.message}`);

test('ssrf_em_todos_os_campos_de_url', async (ctx) => {
  const contagem = {};
  await emTransacao(async (t) => {
    // controle: a URL boa passa em todos os campos (senão a recusa abaixo poderia ser por outro motivo)
    const ok = await tracking.createTrackingLink({ tenant, actor: tenant.userId, input: { targetUrl: BOA, channel: 'EMAIL' } }, t);
    assert.ok(ok.shortCode, 'link com URL boa é criado');
    await templates.createTemplate(tenant, tenant.userId, templateInput({ body: `Veja ${BOA}` }), t);
    assert.equal((await factualResult(t, tenant, `Casa nova. Veja ${BOA}`)).status, 'FACT_CHECKED', 'texto com URL boa passa no conteúdo');
    await upsertSetting('marketing.review.url_avaliacao', 'https://g.page/r/imobiliaria-exemplo/review', tenant, tenant.userId, t);
    await upsertSetting('marketing.pos_chaves.link_pesquisa', BOA, tenant, tenant.userId, t);
    assert.equal(await surveyLink({ tenant, transaction: t }), BOA, 'link da pesquisa com URL boa sai');

    // 1) link rastreável (campo único: aceita qualquer esquema de entrada, recusa todos)
    for (const url of [...PERIGOSAS_WEB, ...PERIGOSAS_ESQUEMA]) {
      await sequelize.query('SAVEPOINT campo', { transaction: t });
      await assert.rejects(() => tracking.createTrackingLink({ tenant, actor: tenant.userId, input: { targetUrl: url, channel: 'EMAIL' } }, t), recusada, `link rastreável aceitou ${url}`);
      await sequelize.query('ROLLBACK TO SAVEPOINT campo', { transaction: t });
    }
    contagem['link rastreável'] = PERIGOSAS_WEB.length + PERIGOSAS_ESQUEMA.length;
    // 2) template (a URL dentro do corpo)
    for (const url of PERIGOSAS_WEB) {
      await sequelize.query('SAVEPOINT campo', { transaction: t });
      await assert.rejects(() => templates.createTemplate(tenant, tenant.userId, templateInput({ body: `Veja ${url}` }), t), (e) => e.statusCode === 422 && e.code === 'MKT_URL_NOT_ALLOWED', `template aceitou ${url}`);
      await sequelize.query('ROLLBACK TO SAVEPOINT campo', { transaction: t });
    }
    contagem.template = PERIGOSAS_WEB.length;
    // 3) texto do conteúdo (a URL na legenda reprova a verificação e o conteúdo não avança)
    for (const url of PERIGOSAS_WEB) {
      const out = await factualResult(t, tenant, `Casa nova. Veja ${url}`);
      assert.equal(out.status, 'FACT_CHECK_FAILED', `conteúdo aceitou ${url}`);
      assert.ok(out.findings.some((f) => /URL/i.test(`${f.kind} ${f.reason} ${f.code || ''}`)), `o motivo de URL consta nos findings para ${url}`);
    }
    contagem['texto do conteúdo'] = PERIGOSAS_WEB.length;
    // 4) URL de avaliação (parâmetro da empresa: a gravação é recusada)
    for (const url of [...PERIGOSAS_WEB, ...PERIGOSAS_ESQUEMA]) {
      await sequelize.query('SAVEPOINT campo', { transaction: t });
      await assert.rejects(() => upsertSetting('marketing.review.url_avaliacao', url, tenant, tenant.userId, t), recusada, `URL de avaliação aceitou ${url}`);
      await sequelize.query('ROLLBACK TO SAVEPOINT campo', { transaction: t });
    }
    contagem['URL de avaliação'] = PERIGOSAS_WEB.length + PERIGOSAS_ESQUEMA.length;
    // 5) link da pesquisa de satisfação (a regra vale na hora de usar: endereço perigoso devolve null e a mensagem não sai)
    for (const url of [...PERIGOSAS_WEB, ...PERIGOSAS_ESQUEMA]) {
      await sequelize.query('SAVEPOINT campo', { transaction: t });
      const gravou = await upsertSetting('marketing.pos_chaves.link_pesquisa', url, tenant, tenant.userId, t).then(() => true, () => false); // recusar na gravação também vale
      await sequelize.query('ROLLBACK TO SAVEPOINT campo', { transaction: t });
      if (gravou) {
        await upsertSetting('marketing.pos_chaves.link_pesquisa', url, tenant, tenant.userId, t);
        assert.equal(await surveyLink({ tenant, transaction: t }), null, `link da pesquisa aceitou ${url}`);
        await upsertSetting('marketing.pos_chaves.link_pesquisa', BOA, tenant, tenant.userId, t);
      }
    }
    contagem['link da pesquisa'] = PERIGOSAS_WEB.length + PERIGOSAS_ESQUEMA.length;
  });
  ctx.diagnostic(`URLs perigosas recusadas por campo: ${Object.entries(contagem).map(([k, v]) => `${k}=${v}`).join(', ')}`);
});
