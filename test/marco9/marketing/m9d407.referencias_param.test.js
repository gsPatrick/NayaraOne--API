'use strict';

// M9-D407 (rodada 5, L-4) com banco: o passo factual lê marketing.factual.referencias_legais da empresa; CNPJ e decreto passam, a palavra tirada da lista volta a ser número inexplicável.
// Banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d407.referencias_param.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const { factualResult } = require('../_helpers/mktFactualEnv');
const fx = require('../_helpers/m9d431Fixtures');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenant;
let cleanup;
before(async () => { ({ tenantA: tenant } = await prepararTenants()); cleanup = fx.useTempSecretStore(); });
after(async () => { cleanup(); await sequelize.close(); });
const KEY = 'marketing.factual.referencias_legais';
const set = (t, value) => upsertSetting(KEY, value, tenant, tenant.userId, t);

test('cnpj_e_decreto_passam_no_passo_factual_com_o_padrao_do_parametro', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    for (const texto of ['Casa de 3 quartos. Nayara Ltda, CNPJ 12.345.678/0001-90.', 'Casa de 3 quartos conforme o Decreto 10.123/19.']) {
      const r = await factualResult(t, tenant, texto);
      assert.equal(r.status, 'FACT_CHECKED', `${texto} ${JSON.stringify(r.findings)}`);
    }
  });
});

test('a_palavra_da_lista_e_parametro_da_empresa: sem "decreto" o numero volta a ser inexplicavel; valor invalido e recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const texto = 'Casa de 3 quartos conforme o Decreto 10.123/19.';
    await set(t, 'lei, portaria');
    const out = await factualResult(t, tenant, texto);
    assert.equal(out.status, 'FACT_CHECK_FAILED');
    assert.ok(out.findings.some((f) => f.kind === 'UNKNOWN_CLAIM'), JSON.stringify(out.findings));
    await set(t, 'lei, decreto');
    assert.equal((await factualResult(t, tenant, texto)).status, 'FACT_CHECKED');
    for (const ruim of ['', '   ,  ']) await assert.rejects(() => set(t, ruim), (e) => e.statusCode >= 400 && e.statusCode < 500, JSON.stringify(ruim));
  });
});
