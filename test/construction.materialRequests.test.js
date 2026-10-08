'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const materialRequestsService = require('../src/features/construction/materialRequests.service');
const AppError = require('../src/utils/AppError');
const { OutboxEvent, InventoryItem, InventoryLocation, InventoryMovement, InventoryStockBalance, AuditLog } = require('../src/models');
const inventoryMovementsService = require('../src/features/inventory/movements.service');

// M6-28 — requisição de material mínima do Marco 6 (integração completa com Estoque é do
// Marco 7, ver src/features/construction/README.md).

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

// BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07): receiveMaterialRequest agora exige
// item/local do estoque — helper cria um item+local real com saldo pra todos os testes que
// precisam disso.
async function createTestStockLink(transaction, qty = 200) {
  const suffix = uniqueSuffix();
  const location = await InventoryLocation.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, name: `HOMO QA MR Local ${suffix}`, locationType: 'WAREHOUSE', createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction }
  );
  const item = await InventoryItem.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      sku: `HOMO-MR-${suffix}`,
      name: `HOMO QA MR Item ${suffix}`,
      unitOfMeasure: 'UN',
      itemType: 'CONSUMABLE',
      averageCost: 10,
      allowNegativeStock: true,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
  await inventoryMovementsService.recordMovement(
    { groupId: tenant.groupId, companyId: tenant.companyId, inventoryItemId: item.id, movementType: 'IN', quantity: qty, destinationLocationId: location.id },
    { userId: tenant.userId, canApprove: true },
    transaction
  );
  return { item, location };
}

async function createTestProject(transaction) {
  const suffix = uniqueSuffix();
  return projectsService.createProject(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      name: `Obra Material ${suffix}`,
    },
    tenant.userId,
    transaction
  );
}

test('material-request: criar requisição publica evento material.requested', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);

    const request = await materialRequestsService.createMaterialRequest(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Cimento CP-II', quantity: 50, unit: 'saco' },
      tenant.userId,
      transaction
    );

    assert.equal(request.status, 'REQUESTED');
    assert.equal(request.projectId, project.id);

    const events = await OutboxEvent.findAll({
      where: { aggregateType: 'MaterialRequest', aggregateId: request.id, eventType: 'material.requested' },
      transaction,
    });
    assert.equal(events.length, 1);
  });
});

// Item 3 (fechamento de gaps pós-Marco 6) — mesmo padrão de captura offline do RDO (M6-94):
// reenviar a mesma `idempotencyKey` (simulando o app sincronizando de novo uma requisição que
// já tinha ido pro servidor) não cria um segundo registro.
test('item 3: idempotencyKey de captura offline evita duplicar requisição de material ao ressincronizar', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const idempotencyKey = `offline-material-${uniqueSuffix()}`;

    const first = await materialRequestsService.createMaterialRequest(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Areia média', quantity: 10, unit: 'm3', idempotencyKey },
      tenant.userId,
      transaction
    );

    const resynced = await materialRequestsService.createMaterialRequest(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Areia média', quantity: 10, unit: 'm3', idempotencyKey },
      tenant.userId,
      transaction
    );

    assert.equal(resynced.id, first.id, 'reenviar a mesma idempotencyKey deve devolver a MESMA requisição, não criar uma segunda');

    const all = await materialRequestsService.listMaterialRequests(project.id, transaction);
    const matching = all.filter((r) => r.idempotencyKey === idempotencyKey);
    assert.equal(matching.length, 1, 'só deve existir UMA requisição persistida com esta idempotencyKey');
  });
});

test('material-request: validação exige description/quantity/unit', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);

    await assert.rejects(
      () =>
        materialRequestsService.createMaterialRequest(
          project.id,
          { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Areia' },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'MATERIAL_REQUEST_VALIDATION');
        return true;
      }
    );
  });
});

test('material-request: quantity precisa ser maior que zero', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);

    await assert.rejects(
      () =>
        materialRequestsService.createMaterialRequest(
          project.id,
          { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Areia', quantity: 0, unit: 'm3' },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'MATERIAL_REQUEST_VALIDATION');
        return true;
      }
    );
  });
});

test('material-request: vínculo com stageId de outra obra é rejeitado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const otherProject = await createTestProject(transaction);
    const stageOfOtherProject = await projectStagesService.createProjectStage(
      otherProject.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, name: 'Fundação' },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () =>
        materialRequestsService.createMaterialRequest(
          project.id,
          {
            groupId: tenant.groupId,
            companyId: tenant.companyId,
            description: 'Vergalhão',
            quantity: 100,
            unit: 'kg',
            stageId: stageOfOtherProject.id,
          },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'MATERIAL_REQUEST_STAGE_INVALID');
        return true;
      }
    );
  });
});

test('material-request: receber marca RECEIVED e publica material.received (idempotente contra dupla confirmação)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const request = await materialRequestsService.createMaterialRequest(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Tijolo', quantity: 1000, unit: 'unidade' },
      tenant.userId,
      transaction
    );

    const { item, location } = await createTestStockLink(transaction, 5000);
    const received = await materialRequestsService.receiveMaterialRequest(request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction, {
      inventoryItemId: item.id,
      sourceLocationId: location.id,
    });
    assert.equal(received.status, 'RECEIVED');
    assert.ok(received.receivedAt);

    const events = await OutboxEvent.findAll({
      where: { aggregateType: 'MaterialRequest', aggregateId: request.id, eventType: 'material.received' },
      transaction,
    });
    assert.equal(events.length, 1);

    // Confirmar recebimento uma segunda vez tem que bloquear — não pode disparar o evento de
    // novo nem voltar silenciosamente sem erro (mesmo padrão de "não duplicar" do módulo).
    await assert.rejects(
      () => materialRequestsService.receiveMaterialRequest(request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction, { inventoryItemId: item.id, sourceLocationId: location.id }),
      (err) => {
        assert.equal(err.code, 'MATERIAL_REQUEST_ALREADY_RECEIVED');
        return true;
      }
    );
  });
});

// BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07; contrato §7/§8): confirmar
// recebimento sem item/local do estoque agora é bloqueado — antes passava silenciosamente.
test('material-request: receber sem inventoryItemId/sourceLocationId é bloqueado (contrato exige vínculo com o Estoque)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const request = await materialRequestsService.createMaterialRequest(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Areia', quantity: 10, unit: 'm3' },
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => materialRequestsService.receiveMaterialRequest(request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'MATERIAL_REQUEST_STOCK_LINK_REQUIRED');
        return true;
      }
    );
  });
});

// BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07; contrato §8: "Devolução/
// reaproveitamento gera movimento inverso"): não existia nenhum caminho de devolução.
test('material-request: devolução de material recebido credita o saldo de volta (movimento RETURN)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const { item, location } = await createTestStockLink(transaction, 100);
    const request = await materialRequestsService.createMaterialRequest(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Tubo PVC', quantity: 20, unit: 'unidade' },
      tenant.userId,
      transaction
    );
    await materialRequestsService.receiveMaterialRequest(request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction, {
      inventoryItemId: item.id,
      sourceLocationId: location.id,
    });
    const balanceAfterReceive = await inventoryMovementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(balanceAfterReceive, 80);

    const { returnMovement } = await materialRequestsService.returnMaterialRequest(
      request.id,
      tenant.groupId,
      tenant.companyId,
      { inventoryItemId: item.id, destinationLocationId: location.id, quantity: 5 },
      tenant.userId,
      transaction
    );
    assert.equal(returnMovement.movementType, 'RETURN');

    const balanceAfterReturn = await inventoryMovementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(balanceAfterReturn, 85, 'devolução precisa creditar de volta o saldo real do item');

    // Devolver de novo com a mesma requisição é idempotente — não duplica o crédito.
    const { returnMovement: replay } = await materialRequestsService.returnMaterialRequest(
      request.id,
      tenant.groupId,
      tenant.companyId,
      { inventoryItemId: item.id, destinationLocationId: location.id, quantity: 5 },
      tenant.userId,
      transaction
    );
    assert.equal(replay.id, returnMovement.id);
    const balanceAfterReplay = await inventoryMovementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(balanceAfterReplay, 85, 'reenviar a devolução não pode creditar duas vezes');
  });
});

// Devolução exige requisição já RECEIVED — devolver uma requisição ainda REQUESTED é bloqueado.
test('material-request: devolução de requisição ainda não recebida é bloqueada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const { item, location } = await createTestStockLink(transaction, 50);
    const request = await materialRequestsService.createMaterialRequest(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Fio elétrico', quantity: 5, unit: 'rolo' },
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => materialRequestsService.returnMaterialRequest(
      request.id,
      tenant.groupId,
      tenant.companyId,
      { inventoryItemId: item.id, destinationLocationId: location.id },
      tenant.userId,
      transaction),
      (err) => {
        assert.equal(err.code, 'MATERIAL_REQUEST_RETURN_REQUIRES_RECEIVED');
        return true;
      }
    );
  });
});

// GAP CORRIGIDO (auditoria pós-Marco 6, item 5): "requisição não baixa saldo real do Estoque".
// Confirma que, quando o recebimento informa inventoryItemId/sourceLocationId, o saldo real do
// item no Estoque cai pela quantidade da requisição, e um InventoryMovement OUT real é criado
// vinculado ao projectId da obra.
test('material-request: receber com vínculo de estoque debita o saldo real (OUT) vinculado ao projectId', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const project = await createTestProject(transaction);

    const location = await InventoryLocation.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        name: `Almoxarifado Teste ${suffix}`,
        locationType: 'WAREHOUSE',
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      },
      { transaction }
    );
    const item = await InventoryItem.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        name: `Cimento Teste ${suffix}`,
        unitOfMeasure: 'saco',
        itemType: 'CONSUMABLE',
        averageCost: 32.5,
        allowNegativeStock: true,
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      },
      { transaction }
    );

    // Entrada inicial no almoxarifado para ter saldo a debitar.
    await inventoryMovementsService.recordMovement(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        inventoryItemId: item.id,
        movementType: 'IN',
        quantity: 200,
        destinationLocationId: location.id,
      },
      { userId: tenant.userId, canApprove: true },
      transaction
    );
    const balanceBefore = await inventoryMovementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(balanceBefore, 200);

    const request = await materialRequestsService.createMaterialRequest(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Cimento CP-II', quantity: 50, unit: 'saco' },
      tenant.userId,
      transaction
    );

    const received = await materialRequestsService.receiveMaterialRequest(request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction, {
      inventoryItemId: item.id,
      sourceLocationId: location.id,
    });
    assert.equal(received.status, 'RECEIVED');

    const balanceAfter = await inventoryMovementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(balanceAfter, 150, 'saldo real do item deveria ter caído pela quantidade da requisição');

    const movement = await InventoryMovement.findOne({
      where: { sourceType: 'REQUISITION', sourceId: request.id, movementType: 'OUT' },
      transaction,
    });
    assert.ok(movement, 'deveria existir um InventoryMovement OUT real vinculado à requisição');
    assert.equal(movement.projectId, project.id, 'movimento precisa estar vinculado ao projectId da obra (EST-004)');
    assert.equal(Number(movement.quantity), 50);
  });
});

test('material-request: listMaterialRequests filtra por status', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const requestA = await materialRequestsService.createMaterialRequest(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Prego', quantity: 5, unit: 'kg' },
      tenant.userId,
      transaction
    );
    await materialRequestsService.createMaterialRequest(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Massa corrida', quantity: 10, unit: 'lata' },
      tenant.userId,
      transaction
    );
    const { item, location } = await createTestStockLink(transaction, 50);
    await materialRequestsService.receiveMaterialRequest(requestA.id, tenant.groupId, tenant.companyId, tenant.userId, transaction, { inventoryItemId: item.id, sourceLocationId: location.id });

    const received = await materialRequestsService.listMaterialRequests(project.id, transaction, { status: 'RECEIVED' });
    assert.equal(received.length, 1);
    assert.equal(received[0].id, requestA.id);

    const requested = await materialRequestsService.listMaterialRequests(project.id, transaction, { status: 'REQUESTED' });
    assert.equal(requested.length, 1);
  });
});

// GAP 2 (fechamento de auditoria externa Nayara, Marco 6): "Conferência detalhada dos
// movimentos e custos de devolução" + "Reaproveitamento de materiais". Devolve material
// REUSABLE: saldo sobe igual ao fluxo normal, e `reusable: true`/`conditionCode: 'REUSABLE'`
// ficam persistidos e consultáveis depois (via audit log, entityId = materialRequest.id).
test('material-request: devolução REUSABLE credita o saldo e persiste reusable=true/conditionCode consultável', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const { item, location } = await createTestStockLink(transaction, 100);
    const request = await materialRequestsService.createMaterialRequest(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Telha cerâmica', quantity: 20, unit: 'unidade' },
      tenant.userId,
      transaction
    );
    await materialRequestsService.receiveMaterialRequest(request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction, {
      inventoryItemId: item.id,
      sourceLocationId: location.id,
    });
    const balanceAfterReceive = await inventoryMovementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(balanceAfterReceive, 80);

    const { returnMovement, returnDetails } = await materialRequestsService.returnMaterialRequest(
      request.id,
      tenant.groupId,
      tenant.companyId,
      { inventoryItemId: item.id, destinationLocationId: location.id, quantity: 6, conditionCode: 'REUSABLE', reusable: true },
      tenant.userId,
      transaction
    );
    assert.equal(returnMovement.movementType, 'RETURN');
    assert.equal(returnDetails.reusable, true);
    assert.equal(returnDetails.conditionCode, 'REUSABLE');
    assert.equal(returnDetails.returnCost, null, 'devolução REUSABLE não precisa de custo de devolução distinto');

    const balanceAfterReturn = await inventoryMovementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(balanceAfterReturn, 86, 'devolução REUSABLE precisa creditar o saldo normalmente');

    // Consultável depois — mesma trilha de auditoria real (audit.audit_log) usada no resto do
    // sistema, filtrável por entityId=materialRequest.id (sem precisar reprocessar nada).
    const auditEntry = await AuditLog.findOne({
      where: { entityType: 'MaterialRequest', entityId: request.id, action: 'construction.material_request.return' },
      order: [['created_at', 'DESC']],
      transaction,
    });
    assert.ok(auditEntry, 'devolução precisa deixar rastro de auditoria consultável');
    assert.equal(auditEntry.afterJson.reusable, true);
    assert.equal(auditEntry.afterJson.conditionCode, 'REUSABLE');
  });
});

// Devolução DAMAGED: saldo sobe igual (material fisicamente voltou ao local), mas o registro
// grava um `returnCost` distinto do custo ORIGINAL do item (averageCost=10 no fixture de
// `createTestStockLink`), consultável depois via auditoria.
test('material-request: devolução DAMAGED credita o saldo e persiste returnCost distinto do custo original', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const { item, location } = await createTestStockLink(transaction, 100); // averageCost = 10
    const request = await materialRequestsService.createMaterialRequest(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Porcelanato', quantity: 20, unit: 'caixa' },
      tenant.userId,
      transaction
    );
    await materialRequestsService.receiveMaterialRequest(request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction, {
      inventoryItemId: item.id,
      sourceLocationId: location.id,
    });
    const balanceAfterReceive = await inventoryMovementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(balanceAfterReceive, 80);

    const { returnMovement, returnDetails } = await materialRequestsService.returnMaterialRequest(
      request.id,
      tenant.groupId,
      tenant.companyId,
      { inventoryItemId: item.id, destinationLocationId: location.id, quantity: 4, conditionCode: 'DAMAGED', returnCost: 3.5 },
      tenant.userId,
      transaction
    );
    assert.equal(returnMovement.movementType, 'RETURN');
    assert.equal(returnDetails.conditionCode, 'DAMAGED');
    assert.equal(returnDetails.returnCost, 3.5);
    assert.equal(returnDetails.originalUnitCost, 10, 'custo original do item precisa continuar disponível pra comparação');
    assert.notEqual(returnDetails.returnCost, returnDetails.originalUnitCost, 'custo de devolução precisa ser distinto do custo original');

    // Saldo físico volta igual — o material voltou fisicamente ao local, só com valor reduzido.
    const balanceAfterReturn = await inventoryMovementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(balanceAfterReturn, 84, 'material danificado ainda ocupa espaço físico — saldo de unidades sobe igual');

    const auditEntry = await AuditLog.findOne({
      where: { entityType: 'MaterialRequest', entityId: request.id, action: 'construction.material_request.return' },
      order: [['created_at', 'DESC']],
      transaction,
    });
    assert.ok(auditEntry);
    assert.equal(Number(auditEntry.afterJson.returnCost), 3.5);
    assert.equal(auditEntry.afterJson.conditionCode, 'DAMAGED');

    // DAMAGED sem "returnCost" explícito usa o default documentado (0 — perda total de valor).
    const requestB = await materialRequestsService.createMaterialRequest(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, description: 'Porcelanato B', quantity: 5, unit: 'caixa' },
      tenant.userId,
      transaction
    );
    await materialRequestsService.receiveMaterialRequest(requestB.id, tenant.groupId, tenant.companyId, tenant.userId, transaction, {
      inventoryItemId: item.id,
      sourceLocationId: location.id,
    });
    const { returnDetails: defaultDetails } = await materialRequestsService.returnMaterialRequest(
      requestB.id,
      tenant.groupId,
      tenant.companyId,
      { inventoryItemId: item.id, destinationLocationId: location.id, quantity: 2, conditionCode: 'DAMAGED' },
      tenant.userId,
      transaction
    );
    assert.equal(defaultDetails.returnCost, 0);
  });
});
