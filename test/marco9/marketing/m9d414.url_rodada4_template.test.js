'use strict';

// M9-D414 (reabertura da rodada 4, M-2) — template e legenda do reel passam pelo mesmo teto de tamanho e pela mesma política de candidato ambíguo sem aprovador.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const mid = require('../_helpers/mktMidia');
const fx = require('../_helpers/m9d431Fixtures');
const templates = require('../../../src/features/marketing/content/template.service');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenant;
let cleanup;
before(async () => { ({ tenantA: tenant } = await prepararTenants()); cleanup = fx.useTempSecretStore(); });
after(async () => { cleanup(); await sequelize.close(); });
const recusa = (reason) => (e) => e.statusCode === 422 && e.code === 'MKT_URL_NOT_ALLOWED' && JSON.stringify(e.details || e).includes(reason);
const set = (t, key, value) => upsertSetting(key, value, tenant, tenant.userId, t);

test('template_recusa_candidato_ambiguo_e_corpo_acima_do_teto', async () => {
  const { templateInput } = require('../../helpers/m9d404Fixtures');
  await withRollbackTenantTransaction(tenant, async (t) => {
    await set(t, 'marketing.url.verificar_destino', false);
    for (const body of ['Veja Rb.gy/Abc12', 'Ab.lol/Login']) await assert.rejects(() => templates.createTemplate(tenant, tenant.userId, templateInput({ body }), t), recusa(''), body);
    for (const body of ['Veja a Av.Paulista', 'Foto foto.jpg']) {
      await assert.rejects(() => templates.createTemplate(tenant, tenant.userId, templateInput({ body }), t), recusa('REVISAO_HUMANA_NECESSARIA'), body);
    }
    await set(t, 'marketing.url.max_chars_campo', 300);
    await assert.rejects(() => templates.createTemplate(tenant, tenant.userId, templateInput({ body: 'Olá {{nome}} '.repeat(60) }), t), recusa('CAMPO_GRANDE_DEMAIS'), 'corpo acima do teto de campo');
    await set(t, 'marketing.url.max_chars_campo', 20000);
    await set(t, 'marketing.url.revisao_sem_aprovador', 'permitir');
    const ok = await templates.createTemplate(tenant, tenant.userId, templateInput({ body: 'Veja a Av.Paulista' }), t);
    assert.equal(ok.status, 'DRAFT', 'política permissiva aceita o ambíguo');
  });
});

test('legenda_do_reel_recusa_candidato_ambiguo_e_texto_acima_do_teto', async () => {
  const c = await mid.setup();
  await mid.withRollbackTenantTransaction(c.tenant, async (t) => {
    await upsertSetting('marketing.url.verificar_destino', false, c.tenant, c.tenant.userId, t);
    const f = await mid.authorizedFile(t, c.tenant, { mime: 'image/jpeg', name: 'fachada.jpg' });
    for (const text of ['Veja Rb.gy/Abc12', 'Ab.lol/Login']) await assert.rejects(mid.assemble(t, c.tenant, { midias: [f.id], operacoes: [{ op: 'CAPTION', text }] }), recusa(''), text);
    await assert.rejects(mid.assemble(t, c.tenant, { midias: [f.id], operacoes: [{ op: 'CAPTION', text: 'Veja a Av.Paulista' }] }), recusa('REVISAO_HUMANA_NECESSARIA'));
    assert.equal(await mid.count(t, 'marketing.media_derivatives'), 0, 'legenda recusada não gera derivado');
    await upsertSetting('marketing.url.max_chars_campo', 200, c.tenant, c.tenant.userId, t);
    await assert.rejects(mid.assemble(t, c.tenant, { midias: [f.id], operacoes: [{ op: 'CAPTION', text: 'Sala ampla '.repeat(24) }] }), recusa('CAMPO_GRANDE_DEMAIS'));
  });
});
