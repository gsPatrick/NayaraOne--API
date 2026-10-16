'use strict';

// Achado numa auditoria do FRONT do Marco 6 (30/09/2026) — bug real crítico, mesma classe do
// já corrigido em construction.adminPermissions.test.js: as permissões `finance:*` foram
// seedadas no catálogo, mas nunca concedidas ao papel ADMIN de nenhuma empresa. Sem isso, TODO
// endpoint do módulo Financeiro responde 403 pra qualquer usuário, inclusive o administrador —
// inclusive o seletor de centro de custo em "Nova obra"/"Editar obra" (Marco 6), que depende de
// GET /finance/cost-centers. Guarda de regressão.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');

after(async () => {
  await sequelize.close();
});

const REQUIRED_CODES = [
  'finance:create',
  'finance:read',
  'finance:update',
  'finance:approve',
  'finance:settle',
  'finance:reconcile',
  'finance:bankAccounts',
];

test('finance:* — o papel ADMIN da empresa semente tem as 7 permissões do módulo Financeiro concedidas', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const [grantedRows] = await sequelize.query(
      `SELECT p.code
         FROM core.role_permissions rp
         JOIN core.roles r ON r.id = rp.role_id
         JOIN core.permissions p ON p.id = rp.permission_id
        WHERE r.name = 'ADMIN' AND r.company_id = :companyId AND p.code LIKE 'finance:%'`,
      { replacements: { companyId: tenant.companyId }, transaction }
    );
    const grantedCodes = grantedRows.map((r) => r.code).sort();
    for (const code of REQUIRED_CODES) {
      assert.ok(
        grantedCodes.includes(code),
        `ADMIN não tem "${code}" concedida — todo endpoint do Financeiro vai responder 403 pra esse usuário`
      );
    }
  });
});
