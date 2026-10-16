'use strict';

// GAP REAL CORRIGIDO (auditoria Nayara, Marco 7, 14/10/2026): EST-008 exige "motivo, evidência e
// aprovação" pro ajuste de inventário, e o Caderno testa explicitamente "ajuste sem aprovação
// falha" — mas `applyAdjustment` só checava a permissão `inventory:approve`, sem nunca comparar
// contra quem abriu a contagem. Como o usuário admin tem a permissão, ele abria o inventário E
// aplicava o próprio ajuste sozinho. Este teste prova o novo bloqueio de maker-checker: quem abriu
// a contagem não pode aprovar o próprio ajuste (mesmo padrão já usado em Compras/Financeiro).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const countsService = require('../src/features/inventory/counts.service');
const { User } = require('../src/models');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

async function createSecondApprover(suffix) {
  const [user] = await User.findOrCreate({
    where: { email: `homo-qa-est008-${suffix}@nayaraone.dev` },
    defaults: { name: `HOMO QA — EST008 ${suffix}`, passwordHash: 'x', status: 'ACTIVE' },
  });
  return user.id;
}

async function createItemAndWarehouse(transaction) {
  const suffix = uniqueSuffix();
  const item = await itemsService.createItem(
    withTenant({ name: `EST008-SELF Item ${suffix}`, sku: `EST008SELF-${suffix}`, unitOfMeasure: 'UN' }),
    tenant.userId,
    transaction
  );
  const location = await itemsService.createLocation(
    withTenant({ name: `EST008-SELF Depósito ${suffix}` , locationType: 'WAREHOUSE' }),
    tenant.userId,
    transaction
  );
  return { item, location };
}

async function openAndDivergeCount(transaction, item, location, openedByUserId) {
  const count = await countsService.openCount(withTenant({ locationId: location.id }), openedByUserId, transaction);
  const line = await countsService.addCountItem(count.id, tenant.groupId, tenant.companyId, { inventoryItemId: item.id, countedQuantity: 7 }, transaction);
  await countsService.completeCount(count.id, tenant.groupId, tenant.companyId, openedByUserId, transaction);
  return { count, line };
}

test('EST-008: quem abriu o inventário não pode aplicar o próprio ajuste, mesmo tendo inventory:approve', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction);
    const { line } = await openAndDivergeCount(transaction, item, location, tenant.userId);

    await assert.rejects(
      () => countsService.applyAdjustment(line.id, tenant.groupId, tenant.companyId, { userId: tenant.userId, canApprove: true }, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INVENTORY_COUNT_SELF_APPROVAL_BLOCKED');
        return true;
      }
    );
  });
});

test('EST-008: um segundo usuário com inventory:approve consegue aplicar o ajuste normalmente', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const approverUserId = await createSecondApprover(suffix);
    const { item, location } = await createItemAndWarehouse(transaction);
    const { line } = await openAndDivergeCount(transaction, item, location, tenant.userId);

    const adjusted = await countsService.applyAdjustment(line.id, tenant.groupId, tenant.companyId, { userId: approverUserId, canApprove: true }, transaction);
    assert.ok(adjusted.adjustmentMovementId, 'ajuste deveria ter gerado um movimento ADJUSTMENT');
  });
});
