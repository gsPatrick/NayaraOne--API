'use strict';

// Achados reais da auditoria Marco 7 (rodada "check", 15/10/2026):
//   1. openCount num canteiro (PROJECT_SITE) não derivava a obra do próprio cadastro do local —
//      o payload podia divergir (mesma inconsistência já corrigida em requisitions.service.js).
//   2. createReceipt não expunha supplierPersonId na listagem/detalhe (fornecedor nunca aparecia).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const countsService = require('../src/features/inventory/counts.service');
const receiptsService = require('../src/features/inventory/receipts.service');
const projectsService = require('../src/features/construction/projects.service');
const { Person } = require('../src/models');
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

test('openCount deriva a obra do cadastro do canteiro, ignorando qualquer projectId divergente do payload', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const realProject = await projectsService.createProject(withTenant({ name: `Obra real ${suffix}` }), tenant.userId, transaction);
    const otherProject = await projectsService.createProject(withTenant({ name: `Obra divergente ${suffix}` }), tenant.userId, transaction);
    const site = await itemsService.createLocation(
      withTenant({ name: `Canteiro ${suffix}`, locationType: 'PROJECT_SITE', projectId: realProject.id }),
      tenant.userId,
      transaction
    );

    // Mesmo enviando um projectId divergente (ou nenhum), a contagem sai com a obra REAL do canteiro.
    const count = await countsService.openCount(withTenant({ locationId: site.id, projectId: otherProject.id }), tenant.userId, transaction);
    assert.equal(count.projectId, realProject.id, 'a obra da contagem tem que ser a do cadastro do canteiro, nunca a enviada no payload');
  });
});

test('openCount num canteiro sem obra cadastrada é bloqueado com mensagem orientando o cadastro', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    // Canteiro legado: criado antes da correção F2 não teria projectId. Simula direto no banco
    // (sem passar por createLocation, que já bloqueia isso na criação).
    const { InventoryLocation } = require('../src/models');
    const legacySite = await InventoryLocation.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, name: `Canteiro legado ${suffix}`, locationType: 'PROJECT_SITE', projectId: null },
      { transaction }
    );

    await assert.rejects(
      () => countsService.openCount(withTenant({ locationId: legacySite.id }), tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INVENTORY_COUNT_PROJECT_REQUIRED');
        return true;
      }
    );
  });
});

test('createReceipt com supplierPersonId: listReceipts e getReceipt resolvem o nome do fornecedor', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { InventoryLocation, InventoryItem } = require('../src/models');
    const location = await InventoryLocation.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, name: `Almoxarifado ${suffix}`, locationType: 'WAREHOUSE' },
      { transaction }
    );
    const item = await InventoryItem.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, name: `Item ${suffix}`, sku: `SKU-${suffix}`, unitOfMeasure: 'UN' },
      { transaction }
    );
    const supplier = await Person.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PJ', legalName: `Fornecedor Fictício ${suffix}` },
      { transaction }
    );

    const receipt = await receiptsService.createReceipt(
      withTenant({
        destinationLocationId: location.id,
        supplierPersonId: supplier.id,
        invoiceFingerprint: `fingerprint-${suffix}`,
        items: [{ inventoryItemId: item.id, quantity: 5, unitCost: 10 }],
      }),
      tenant.userId,
      transaction
    );

    const fetched = await receiptsService.getReceipt(receipt.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(fetched.supplier?.legalName, `Fornecedor Fictício ${suffix}`, 'getReceipt precisa resolver o nome do fornecedor');

    const list = await receiptsService.listReceipts(tenant.groupId, tenant.companyId, transaction, {});
    const inList = list.find((r) => r.id === receipt.id);
    assert.equal(inList?.supplier?.legalName, `Fornecedor Fictício ${suffix}`, 'listReceipts também precisa trazer o fornecedor resolvido');
  });
});
