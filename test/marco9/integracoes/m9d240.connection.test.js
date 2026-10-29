'use strict';

// Marco 9, M9-D240 — a connection de financiamento do Correspondente com estados deixados por outras connections do mesmo fornecedor (sem 409, sem duplicar).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d240Env');
const { ensureFinancingConnection } = require('../../../src/features/correspondent/dispatch/financingConnection');
const { IntegrationConnection } = require('../../../src/models');

const { sequelize, withRollbackTenantTransaction } = env;
let tenant;
before(async () => { tenant = await env.carregar(); });
after(async () => { await sequelize.close(); });

const ctx = () => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId });
const ambiente = () => require('../../../src/features/integrations/registry/registry.service').getServerEnvironment();
const { literal } = require('sequelize');
// Desativa o que sobrou de outros testes e libera os rótulos, para o cenário (rótulo padrão já usado por uma desativada) ser montado de forma determinística.
const limpar = (t) => IntegrationConnection.update({ status: 'DISABLED', label: literal("'old-' || id::text") }, { where: { companyId: tenant.companyId, providerCode: 'financing-sandbox' }, transaction: t });
const nova = (t, status, label) => IntegrationConnection.create({ groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'financing-sandbox', environment: ambiente(), label, status }, { transaction: t });

test('m9_d240_connection_desativada_nao_gera_409', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await limpar(t);
    await nova(t, 'DISABLED', `Correspondente: financing-sandbox (${tenant.companyId.slice(0, 8)})`);
    const c = await ensureFinancingConnection(ctx(), 'sandbox', t);
    assert.equal(c.status, 'ACTIVE');
    assert.equal((await ensureFinancingConnection(ctx(), 'sandbox', t)).id, c.id, 'segunda chamada reaproveita, não duplica');
  });
});

test('m9_d240_connection_rascunho_reaproveitada_e_pausada_da_404', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await limpar(t);
    const rascunho = await nova(t, 'DRAFT', 'Rascunho D240');
    assert.equal((await ensureFinancingConnection(ctx(), 'sandbox', t)).id, rascunho.id);
    rascunho.status = 'PAUSED'; await rascunho.save({ transaction: t });
    await assert.rejects(ensureFinancingConnection(ctx(), 'sandbox', t), (e) => e.code === 'INTEGRATION_CONNECTION_NOT_FOUND');
  });
});
