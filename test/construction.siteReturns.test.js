'use strict';

// Matriz de fechamento do Marco 6 (10/11/2026) — "devoluções e estornos no canteiro" e "reflexos no
// Estoque e no Financeiro" (Caderno §5 consumed_inventory_cost/projected_total_cost, §8 "Devolução/
// reaproveitamento gera movimento inverso", §12 "Material devolvido → saldo/custo correto"). Os testes
// existentes provavam o SALDO da devolução e o custo com movimentos avulsos; este percorre o fluxo da
// obra (requisição → recebimento → devolução / perda → estorno da perda) e confere, a cada passo, o
// saldo do almoxarifado E o read model de custo da obra (GET .../health).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { setThresholds } = require('./constructionM6vFixture');
const { InventoryItem, InventoryLocation, LossRecord } = require('../src/models');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const materialRequestsService = require('../src/features/construction/materialRequests.service');
const lossRecordsService = require('../src/features/construction/lossRecords.service');
const projectHealthService = require('../src/features/construction/projectHealth.service');
const movements = require('../src/features/inventory/movements.service');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
});
after(async () => {
  await sequelize.close();
});
const W = (f) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...f });

async function canteiro(t, { unitCost = 10, stock = 100 } = {}) {
  const s = uniqueSuffix();
  const project = await projectsService.createProject(W({ name: `QA M6 Canteiro ${s}`, budgetAmount: 10000 }), tenant.userId, t);
  const stage = await projectStagesService.createProjectStage(project.id, W({ name: 'Alvenaria', stageCode: `ALV-${s}`, sequence: 1, plannedPct: 100, plannedCost: 5000 }), tenant.userId, t);
  const local = await InventoryLocation.create({ ...W({}), name: `QA M6 Almox ${s}`, locationType: 'WAREHOUSE', createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
  const item = await InventoryItem.create(
    { ...W({}), sku: `QA-M6-CT-${s}`, name: `QA M6 Bloco ${s}`, unitOfMeasure: 'UN', itemType: 'CONSUMABLE', averageCost: unitCost, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction: t }
  );
  await movements.recordMovement(W({ inventoryItemId: item.id, movementType: 'IN', quantity: stock, unitCost, destinationLocationId: local.id }), { userId: tenant.userId, canApprove: true }, t);
  const saldo = () => movements.getBalance(item.id, local.id, tenant.groupId, tenant.companyId, t);
  const custo = async () => (await projectHealthService.getProjectHealth(project.id, t)).consumedInventoryCost;
  const requisitar = async (quantity) => {
    const mr = await materialRequestsService.createMaterialRequest(project.id, W({ description: 'Bloco cerâmico', quantity, unit: 'UN', stageId: stage.id }), tenant.userId, t);
    return materialRequestsService.receiveMaterialRequest(mr.id, tenant.groupId, tenant.companyId, tenant.userId, t, { inventoryItemId: item.id, sourceLocationId: local.id, stageId: stage.id });
  };
  const devolver = (mr, extra) => materialRequestsService.returnMaterialRequest(mr.id, tenant.groupId, tenant.companyId, { inventoryItemId: item.id, destinationLocationId: local.id, ...extra }, tenant.userId, t);
  return { project, saldo, custo, requisitar, devolver };
}

test('M6-28/M6-60: devolução REUSABLE do canteiro devolve o saldo e abate o custo consumido da obra; reenvio não estorna duas vezes', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const c = await canteiro(t);
    const mr = await c.requisitar(10);
    assert.equal(await c.saldo(), 90, 'recebimento debita o almoxarifado (OUT)');
    assert.equal(await c.custo(), 100, 'custo consumido = 10 un x R$ 10');
    await c.devolver(mr, { quantity: 4, conditionCode: 'REUSABLE' });
    assert.equal(await c.saldo(), 94, 'devolução credita o almoxarifado (RETURN)');
    assert.equal(await c.custo(), 60, 'o estorno abate 4 un x R$ 10 do custo da obra');
    try {
      await c.devolver(mr, { quantity: 4, conditionCode: 'REUSABLE' });
    } catch (err) {
      assert.ok(err.code, 'reenvio recusado com código de negócio');
    }
    assert.equal(await c.saldo(), 94, 'reenvio não credita duas vezes');
    assert.equal(await c.custo(), 60, 'reenvio não estorna duas vezes');
  });
});

test('M6-60: devolução DAMAGED volta ao saldo sem valor (a obra continua com o custo); LOST não mexe em saldo nem custo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const c = await canteiro(t);
    const danificado = await c.requisitar(5);
    const perdido = await c.requisitar(3);
    assert.equal(await c.saldo(), 92);
    assert.equal(await c.custo(), 80);
    await c.devolver(danificado, { quantity: 5, conditionCode: 'DAMAGED' });
    assert.equal(await c.saldo(), 97, 'material danificado volta fisicamente ao almoxarifado');
    assert.equal(await c.custo(), 80, 'sem valor de devolução (returnCost 0): a obra continua arcando com o custo');
    await c.devolver(perdido, { quantity: 3, conditionCode: 'LOST' });
    assert.equal(await c.saldo(), 97, 'LOST não credita saldo (o material não voltou)');
    assert.equal(await c.custo(), 80, 'LOST não estorna custo');
  });
});

test('M6-29/M6-99: perda aprovada entra no desperdício; o estorno (devolução da perda) é append-only e zera o desperdício', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await setThresholds(tenant, t, { MATERIAL_LOSS: 1000 }); // alçada é configuração da empresa (DI-M6V-6): sem padrão no código
    const c = await canteiro(t);
    const kpis = async () => (await projectHealthService.getProjectHealth(c.project.id, t)).kpis;
    const loss = await lossRecordsService.createLossRecord(c.project.id, W({ materialDescription: 'Bloco quebrado', quantity: 20, estimatedValue: 200, reason: 'Quebra no descarregamento', idempotencyKey: `l-${uniqueSuffix()}` }), tenant.userId, t);
    assert.equal(loss.status, 'APPROVED', 'dentro da alçada padrão');
    const antes = await kpis();
    assert.ok(antes.wastagePct > 0, 'perda aprovada entra no desperdício');
    const chave = `lr-${uniqueSuffix()}`;
    const estorno = await lossRecordsService.returnLossRecord(loss.id, { quantity: 20, idempotencyKey: chave }, tenant.userId, t);
    const replay = await lossRecordsService.returnLossRecord(loss.id, { quantity: 20, idempotencyKey: chave }, tenant.userId, t);
    assert.equal(replay.id, estorno.id, 'reenvio com a mesma chave devolve o mesmo estorno');
    assert.equal((await kpis()).wastagePct, 0, 'estorno total zera o desperdício');
    const original = await LossRecord.findByPk(loss.id, { transaction: t });
    assert.equal(original.movementType, 'LOSS');
    assert.equal(Number(original.estimatedValue), 200, 'o registro original da perda não foi apagado nem alterado');
    assert.equal(await LossRecord.count({ where: { relatedLossRecordId: loss.id, movementType: 'RETURN' }, transaction: t }), 1);
  });
});
