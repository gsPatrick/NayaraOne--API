'use strict';

// Marco 9, M9-D240 — reabertura R5-L1: a migração do segredo para o cofre não pode colidir com a referência de outra connection do mesmo fornecedor (passada repetida no mesmo banco).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d240Env');
const registry = require('../../../src/features/integrations/registry/registry.service');
const { uniqueCanonicalRef } = require('../../../src/features/integrations/secrets');
const { IntegrationConnection } = require('../../../src/models');

const { sequelize, withRollbackTenantTransaction, uniqueSuffix } = env;
let tenant;
before(async () => { tenant = await env.carregar(); });
after(async () => { await sequelize.close(); });

const nova = (t) => registry.createConnection({ providerCode: 'financing-sandbox', environment: registry.getServerEnvironment(), label: `QA-M9 ref ${uniqueSuffix()}` }, env.ctxDe(), t);

test('m9_d240_referencia_canonica_nao_colide_com_outra_connection', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const base = `company/${tenant.companyId}/financing/financing-sandbox`;
    await IntegrationConnection.update({ secretRef: null }, { where: { companyId: tenant.companyId, providerCode: 'financing-sandbox' }, transaction: t });
    const a = await nova(t);
    const b = await nova(t);
    assert.equal(await uniqueCanonicalRef(a, base, t), base, 'ninguém usa a referência: ela é a canônica');
    await IntegrationConnection.update({ secretRef: base }, { where: { id: a.id }, transaction: t });
    assert.equal(await uniqueCanonicalRef(a, base, t), base, 'a própria connection continua com a sua');
    const outra = await uniqueCanonicalRef(b, base, t);
    assert.notEqual(outra, base, 'a referência em uso por outra connection não é repetida');
    assert.ok(outra.startsWith(`${base}-`));
    assert.equal(await uniqueCanonicalRef(b, base, t), outra, 'determinística');
  });
});
