'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { InventoryItem } = require('../src/models');

// Marco 7 — SKU único por empresa sem diferenciar maiúsculas (migration 570). Antes, o índice
// (company_id, sku) aceitava "abc" ao lado de "ABC" quando a escrita não passava pelo serviço.

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function itemData(sku, suffix) {
  return {
    groupId: tenant.groupId,
    companyId: tenant.companyId,
    sku,
    name: `SKU-CI ${suffix}`,
    unitOfMeasure: 'UN',
    itemType: 'CONSUMABLE',
    createdBy: tenant.userId,
    updatedBy: tenant.userId,
  };
}

test('M7-SKU-CI: o banco recusa SKU que só difere em maiúsculas/minúsculas na mesma empresa', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    await InventoryItem.create(itemData(`SKU-CI-${suffix}`, suffix), { transaction });
    await sequelize.query('SAVEPOINT sku_ci', { transaction });
    await assert.rejects(
      () => InventoryItem.create(itemData(`sku-ci-${suffix}`.toLowerCase(), `${suffix}-b`), { transaction }),
      (err) => {
        assert.match(String(err.parent?.constraint || err.original?.constraint || err.message), /inventory_items_company_id_sku_lower_unique/);
        return true;
      }
    );
    await sequelize.query('ROLLBACK TO SAVEPOINT sku_ci', { transaction });
  });
});

test('M7-SKU-CI: SKU diferente de verdade continua aceito', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    await InventoryItem.create(itemData(`SKU-CI-A-${suffix}`, suffix), { transaction });
    const other = await InventoryItem.create(itemData(`SKU-CI-B-${suffix}`, `${suffix}-b`), { transaction });
    assert.ok(other.id);
  });
});
