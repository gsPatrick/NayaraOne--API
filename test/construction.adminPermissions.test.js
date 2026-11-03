'use strict';

// M6-XX (achado numa rodada de verificação de integrações, 30/09/2026) — bug real crítico:
// as permissões `construction:*` foram seedadas, mas nunca concedidas ao papel ADMIN de
// nenhuma empresa. Sem isso, TODO endpoint de Obras responde 403 pra qualquer usuário,
// inclusive o administrador, apesar do código estar funcional. Este teste é um guarda de
// regressão — falha alto e claro se essa concessão for perdida de novo no futuro (ex.: reset
// de banco sem rodar a migration de grant, ou remoção acidental da linha).

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');

after(async () => {
  await sequelize.close();
});

const REQUIRED_CODES = ['construction:create', 'construction:read', 'construction:update', 'construction:approve', 'construction:delete'];

test('construction:* — o papel ADMIN da empresa semente tem as 5 permissões do módulo de Obras concedidas', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const [grantedRows] = await sequelize.query(
      `SELECT p.code
         FROM core.role_permissions rp
         JOIN core.roles r ON r.id = rp.role_id
         JOIN core.permissions p ON p.id = rp.permission_id
        WHERE r.name = 'ADMIN' AND r.company_id = :companyId AND p.code LIKE 'construction:%'`,
      { replacements: { companyId: tenant.companyId }, transaction }
    );
    const grantedCodes = grantedRows.map((r) => r.code).sort();
    for (const code of REQUIRED_CODES) {
      assert.ok(
        grantedCodes.includes(code),
        `ADMIN não tem "${code}" concedida — todo endpoint de Obras vai responder 403 pra esse usuário`
      );
    }
  });
});
