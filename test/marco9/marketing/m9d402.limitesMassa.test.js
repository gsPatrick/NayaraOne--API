'use strict';

// M9-D402 (reabertura F02) — o teto absoluto de destinatários não pode ficar abaixo do limite sem aprovação.
// Só em banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d402.limitesMassa.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

const SEM = 'marketing.mass.max_recipients_sem_aprovacao';
const ABS = 'marketing.mass.max_recipients_absoluto';
let tenant;
before(async () => { ({ tenantA: tenant } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const recusa = (p, key) => assert.rejects(p, (e) => e.statusCode === 422 && e.code === 'MKT_MASS_LIMITS_INCONSISTENT' && e.details.key === key);

test('teto_absoluto_abaixo_do_limite_sem_aprovacao_recusa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await upsertSetting(SEM, 50, tenant, tenant.userId, t);
    await assert.rejects(upsertSetting(ABS, 10, tenant, tenant.userId, t), (e) => e.statusCode === 422 && e.code === 'MKT_MASS_LIMITS_INCONSISTENT'
      && e.message === 'O teto absoluto de destinatários não pode ser menor que o limite sem aprovação (50).');
    await upsertSetting(ABS, 50, tenant, tenant.userId, t); // igual é permitido
  });
});

test('limite_sem_aprovacao_acima_do_teto_recusa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await upsertSetting(SEM, 50, tenant, tenant.userId, t);
    await upsertSetting(ABS, 60, tenant, tenant.userId, t);
    await recusa(upsertSetting(SEM, 80, tenant, tenant.userId, t), SEM);
    await upsertSetting(SEM, 60, tenant, tenant.userId, t);
  });
});

test('sem_configuracao_vale_o_padrao_do_catalogo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await recusa(upsertSetting(SEM, 5001, tenant, tenant.userId, t), SEM); // padrão do teto: 5000
    await upsertSetting(SEM, 40, tenant, tenant.userId, t);
  });
});
