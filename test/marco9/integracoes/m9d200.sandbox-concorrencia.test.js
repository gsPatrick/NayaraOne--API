'use strict';

// Marco 9, M9-D200 (reabertura da hermeticidade) — ensureSandboxConnection reaproveita o rascunho de forma atômica: 50 pedidos simultâneos sobre o mesmo DRAFT,
// nenhum perdido ("ACTIVE -> ACTIVE") e uma só connection ACTIVE. Roda em banco descartável (os testes COMMITAM).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, carregarTenants, ctxDe, comTenant } = require('../../integrations/dispatch/dispatchHelpers');
const { ensureSandboxConnection } = require('../../../src/features/integrations/registry/connections.ensureSandbox');
const { getServerEnvironment } = require('../../../src/features/integrations/registry/registry.helpers');

const PROVEDOR = 'messaging-sandbox';

after(async () => { await sequelize.close(); });

const consultar = (tenant, sql, replacements = {}) => comTenant(tenant, async (t) => (await sequelize.query(sql, { replacements, transaction: t }))[0]);

async function prepararRascunho(tenant) {
  const env = getServerEnvironment();
  await consultar(tenant, "UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code = :p AND environment = :e AND status <> 'DISABLED'",
    { c: tenant.companyId, p: PROVEDOR, e: env });
  const [linha] = await consultar(tenant,
    `INSERT INTO integration.connections (id, group_id, company_id, provider_code, environment, label, status, config_json, policy_json, created_at, updated_at)
     VALUES (gen_random_uuid(), :g, :c, :p, :e, :l, 'DRAFT', '{}', '{}', now(), now()) RETURNING id`,
    { g: tenant.groupId, c: tenant.companyId, p: PROVEDOR, e: env, l: `QA-M9 rascunho ${Date.now()}` });
  return { env, rascunhoId: linha.id };
}

test('sandbox_rascunho_reaproveitado_com_50_pedidos_simultaneos_sem_perda', async () => {
  const { tenant } = await carregarTenants();
  const { env, rascunhoId } = await prepararRascunho(tenant);
  const ctx = ctxDe(tenant);
  const resultados = await Promise.allSettled(Array.from({ length: 50 }, () => comTenant(tenant, (t) => ensureSandboxConnection(ctx, { providerCode: PROVEDOR, label: 'QA-M9' }, t))));
  const falhas = resultados.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  assert.deepEqual(falhas, [], 'nenhum pedido pode ser perdido');
  assert.ok(resultados.every((r) => r.value.id === rascunhoId), 'todos recebem a connection do rascunho reaproveitado');
  const ativas = await consultar(tenant, "SELECT id FROM integration.connections WHERE company_id = :c AND provider_code = :p AND environment = :e AND status = 'ACTIVE'",
    { c: tenant.companyId, p: PROVEDOR, e: env });
  assert.equal(ativas.length, 1);
  assert.equal(ativas[0].id, rascunhoId);
});

test('sandbox_ativa_para_ativa_e_sucesso_idempotente', async () => {
  const { tenant } = await carregarTenants();
  await prepararRascunho(tenant);
  const ctx = ctxDe(tenant);
  const a = await comTenant(tenant, (t) => ensureSandboxConnection(ctx, { providerCode: PROVEDOR, label: 'QA-M9' }, t));
  const b = await comTenant(tenant, (t) => ensureSandboxConnection(ctx, { providerCode: PROVEDOR, label: 'QA-M9' }, t));
  assert.equal(a.id, b.id);
  assert.equal(b.status, 'ACTIVE');
});
