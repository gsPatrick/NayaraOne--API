'use strict';

// GAPS REAIS CORRIGIDOS (auditoria de conformidade contratual Marco 7 — Estoque/Patrimônio,
// 2026-10-07), contra o PDF bruto do contrato:
//   Gap 1 — EST-006: saída de ferramenta registra DESTINO (loanTool exigindo destinationLocationId).
//   Gap 2 — EST-004: requisição com project_id/STAGE_ID (stageId validado contra a obra).
//   Gap 3 — Caderno §9: "Venda/descarte exige processo e vínculo financeiro quando houver valor".
//   Gap 4 — Caderno §10: "Durante contagem, política define freeze lógico ou reconciliação" —
//           implementado como freeze lógico (stock-take lock) por local.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const {
  AuditLog,
  FileLink,
  FinancialEntry,
  InventoryCount,
  InventoryItem,
  InventoryLocation,
  InventoryMovement,
  OutboxEvent,
  ResultCenter,
} = require('../src/models');
const itemsService = require('../src/features/inventory/items.service');
const movementsService = require('../src/features/inventory/movements.service');
const countsService = require('../src/features/inventory/counts.service');
const requisitionsService = require('../src/features/inventory/requisitions.service');
const assetsService = require('../src/features/inventory/assets.service');
const toolLoansService = require('../src/features/inventory/toolLoans.service');
const maintenanceService = require('../src/features/inventory/maintenance.service');
const lossCasesService = require('../src/features/inventory/lossCases.service');
const filesService = require('../src/features/files/files.service');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const AppError = require('../src/utils/AppError');

let tenant;
let approver;
let operator;

before(async () => {
  tenant = await getSeedTenant();
  approver = { userId: tenant.userId, canApprove: true };
  operator = { userId: tenant.userId, canApprove: false };
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

function expectCode(code) {
  return (err) => {
    assert.ok(err instanceof AppError, `esperava AppError ${code}, veio: ${err?.message}`);
    assert.equal(err.code, code);
    return true;
  };
}

async function createLocation(transaction, locationType = 'WAREHOUSE', extra = {}) {
  return itemsService.createLocation(withTenant({ name: `GAP M7 Local ${uniqueSuffix()}`, locationType, ...extra }), tenant.userId, transaction);
}

async function createItem(transaction, extra = {}) {
  const suffix = uniqueSuffix();
  return itemsService.createItem(withTenant({ name: `GAP M7 Item ${suffix}`, sku: `GAPM7-${suffix}`, unitOfMeasure: 'UN', ...extra }), tenant.userId, transaction);
}

async function createEvidence(transaction) {
  return filesService.uploadFile(
    withTenant({ fileName: 'evidencia-baixa.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('NF VENDA').toString('base64'), category: 'generic' }),
    tenant.userId,
    transaction
  );
}

async function createAsset(transaction, extra = {}) {
  const suffix = uniqueSuffix();
  return assetsService.createAsset(withTenant({ name: `Gerador ${suffix}`, assetTag: `DISP-${suffix}`, ...extra }), tenant.userId, transaction);
}

// ---------------------------------------------------------------------------------------------
// Gap 1 — EST-006: destino da saída de ferramenta
// ---------------------------------------------------------------------------------------------

test('Gap 1 (EST-006): loanTool sem destinationLocationId é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);
    await assert.rejects(
      () => toolLoansService.loanTool(asset.id, { personUserId: tenant.userId }, tenant.userId, transaction),
      expectCode('TOOL_LOAN_VALIDATION')
    );
    await asset.reload({ transaction });
    assert.equal(asset.status, 'AVAILABLE', 'empréstimo recusado não pode alterar o asset');
  });
});

test('Gap 1 (EST-006): loanTool com destino inexistente é recusado com erro de negócio (não erro cru de FK)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);
    await assert.rejects(
      () => toolLoansService.loanTool(asset.id, { personUserId: tenant.userId, destinationLocationId: '00000000-0000-4000-8000-000000000000' }, tenant.userId, transaction),
      expectCode('INVENTORY_LOCATION_NOT_FOUND')
    );
  });
});

test('Gap 1 (EST-006): loanTool registra responsável, destino e data prevista, e move o asset pro destino', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const origin = await createLocation(transaction);
    const destination = await createLocation(transaction);
    const asset = await createAsset(transaction, { currentLocationId: origin.id });
    const dueAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

    const loan = await toolLoansService.loanTool(asset.id, { personUserId: tenant.userId, destinationLocationId: destination.id, dueAt }, tenant.userId, transaction);
    assert.equal(loan.personUserId, tenant.userId);
    assert.equal(loan.destinationLocationId, destination.id);
    assert.equal(loan.sourceLocationId, origin.id);
    assert.ok(loan.dueAt);

    await asset.reload({ transaction });
    assert.equal(asset.status, 'LOANED');
    assert.equal(asset.currentLocationId, destination.id);
  });
});

// ---------------------------------------------------------------------------------------------
// Gap 2 — EST-004: etapa (stage_id) na requisição
// ---------------------------------------------------------------------------------------------

async function createProjectWithStage(transaction) {
  const project = await projectsService.createProject(withTenant({ name: `Obra GAP M7 ${uniqueSuffix()}` }), tenant.userId, transaction);
  const stage = await projectStagesService.createProjectStage(project.id, withTenant({ name: 'Fundação' }), tenant.userId, transaction);
  return { project, stage };
}

test('Gap 2 (EST-004): requisição grava stageId quando a etapa pertence à obra', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { project, stage } = await createProjectWithStage(transaction);
    const warehouse = await createLocation(transaction);
    const site = await createLocation(transaction, 'PROJECT_SITE', { projectId: project.id });
    const item = await createItem(transaction);

    const requisition = await requisitionsService.createRequisition(
      withTenant({ warehouseLocationId: warehouse.id, projectLocationId: site.id, projectId: project.id, stageId: stage.id, items: [{ inventoryItemId: item.id, quantity: 2 }] }),
      tenant.userId,
      transaction
    );
    assert.equal(requisition.projectId, project.id);
    assert.equal(requisition.stageId, stage.id);
  });
});

test('Gap 2 (EST-004): requisição recusa stageId de outra obra', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { project } = await createProjectWithStage(transaction);
    const { stage: otherStage } = await createProjectWithStage(transaction);
    const warehouse = await createLocation(transaction);
    const site = await createLocation(transaction, 'PROJECT_SITE', { projectId: project.id });
    const item = await createItem(transaction);

    await assert.rejects(
      () => requisitionsService.createRequisition(
        withTenant({ warehouseLocationId: warehouse.id, projectLocationId: site.id, projectId: project.id, stageId: otherStage.id, items: [{ inventoryItemId: item.id, quantity: 1 }] }),
        tenant.userId,
        transaction
      ),
      expectCode('INVENTORY_REQUISITION_STAGE_INVALID')
    );
  });
});

test('Gap 2 (EST-004): requisição recusa stageId sem projectId', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { stage } = await createProjectWithStage(transaction);
    const warehouse = await createLocation(transaction);
    const item = await createItem(transaction);
    await assert.rejects(
      () => requisitionsService.createRequisition(
        withTenant({ warehouseLocationId: warehouse.id, stageId: stage.id, items: [{ inventoryItemId: item.id, quantity: 1 }] }),
        tenant.userId,
        transaction
      ),
      expectCode('INVENTORY_REQUISITION_VALIDATION')
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Gap 3 — Caderno §9: venda/descarte com processo e vínculo financeiro
// ---------------------------------------------------------------------------------------------

test('Gap 3 (§9): venda de patrimônio baixa o asset, gera RECEIVABLE com centro de resultado, movimento, evidência, auditoria e evento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const location = await createLocation(transaction);
    const asset = await createAsset(transaction, { currentLocationId: location.id, acquisitionValue: 5000 });
    const evidence = await createEvidence(transaction);

    const result = await assetsService.disposeAsset(
      asset.id,
      { disposalType: 'SALE', disposalValue: '1250.50', reason: 'Equipamento obsoleto vendido.', evidenceFileIds: [evidence.id], counterpartyName: 'Comprador Ltda' },
      approver,
      transaction
    );

    await asset.reload({ transaction });
    assert.equal(asset.status, 'DISPOSED');
    assert.equal(asset.currentLocationId, null, 'patrimônio baixado saiu da empresa — sem local atual');
    assert.equal(asset.assignedToUserId, null);

    // Vínculo financeiro real: lançamento a receber com centro de resultado (receita exige).
    assert.ok(result.financialEntry, 'venda com valor precisa gerar lançamento');
    const entry = await FinancialEntry.findByPk(result.financialEntry.id, { transaction });
    assert.equal(entry.nature, 'RECEIVABLE');
    assert.equal(entry.entryType, 'CREDIT');
    assert.equal(Number(entry.amount), 1250.5);
    assert.ok(entry.resultCenterId, 'RECEIVABLE exige resultCenterId');
    const resultCenter = await ResultCenter.findByPk(entry.resultCenterId, { transaction });
    assert.equal(resultCenter.code, 'PATRIMONIO-ALIENACAO');
    assert.equal(entry.idempotencyKey, `asset-disposal:${asset.id}`);

    // Movimento documentando a saída — origem = local atual, destino = nenhum.
    const movements = await assetsService.listAssetMovements(asset.id, transaction);
    const disposalMovement = movements.find((m) => m.movementType === 'DISPOSAL');
    assert.ok(disposalMovement, 'baixa precisa gerar AssetMovement tipo DISPOSAL no histórico');
    assert.equal(disposalMovement.id, result.movement.id);
    assert.equal(disposalMovement.sourceLocationId, location.id);
    assert.equal(disposalMovement.destinationLocationId, null);

    // Evidência vinculada ao movimento da baixa.
    const links = await FileLink.findAll({ where: { relatedEntityType: 'AssetMovement', relatedEntityId: result.movement.id }, transaction });
    assert.deepEqual(links.map((l) => l.fileId), [evidence.id]);
    assert.equal(links[0].purpose, 'ASSET_DISPOSAL_EVIDENCE');

    // Auditoria canônica + evento de domínio.
    const audit = await AuditLog.findOne({ where: { entityType: 'Asset', entityId: asset.id, action: 'ASSET_DISPOSED' }, transaction });
    assert.ok(audit);
    assert.equal(audit.beforeJson.status, 'AVAILABLE');
    assert.equal(audit.afterJson.disposal.reason, 'Equipamento obsoleto vendido.');
    const events = await OutboxEvent.findAll({ where: { aggregateType: 'Asset', aggregateId: asset.id, eventType: 'asset.disposed' }, transaction });
    assert.equal(events.length, 1);

    // Leitura de volta da baixa.
    const disposal = await assetsService.getAssetDisposal(asset.id, transaction);
    assert.equal(disposal.disposalType, 'SALE');
    assert.equal(disposal.disposalValue, 1250.5);
    assert.equal(disposal.counterpartyName, 'Comprador Ltda');
    assert.deepEqual(disposal.evidenceFileIds, [evidence.id]);
    assert.equal(disposal.financialEntry.id, entry.id);
  });
});

test('Gap 3 (§9): descarte sem valor baixa o asset sem lançamento financeiro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);
    const evidence = await createEvidence(transaction);
    const result = await assetsService.disposeAsset(asset.id, { disposalType: 'DISCARD', reason: 'Quebrado sem conserto (laudo).', evidenceFileIds: [evidence.id] }, approver, transaction);
    assert.equal(result.financialEntry, null);
    assert.equal(result.disposal.financialEntryId, null);
    await asset.reload({ transaction });
    assert.equal(asset.status, 'DISPOSED');
    const entries = await FinancialEntry.count({ where: { idempotencyKey: `asset-disposal:${asset.id}` }, transaction });
    assert.equal(entries, 0);
  });
});

test('Gap 3 (§9): descarte com valor de sucata também gera vínculo financeiro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);
    const evidence = await createEvidence(transaction);
    const result = await assetsService.disposeAsset(asset.id, { disposalType: 'DISCARD', disposalValue: 80, reason: 'Vendido como sucata.', evidenceFileIds: [evidence.id] }, approver, transaction);
    assert.ok(result.financialEntry);
    assert.equal(Number(result.financialEntry.amount), 80);
  });
});

test('Gap 3 (§9): validações do processo de baixa (alçada, tipo, valor, motivo, evidência)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);
    const evidence = await createEvidence(transaction);
    const base = { disposalType: 'SALE', disposalValue: 100, reason: 'Venda.', evidenceFileIds: [evidence.id] };

    await assert.rejects(() => assetsService.disposeAsset(asset.id, base, operator, transaction), expectCode('ASSET_DISPOSAL_APPROVAL_REQUIRED'));
    await assert.rejects(() => assetsService.disposeAsset(asset.id, { ...base, disposalType: 'SOLD' }, approver, transaction), expectCode('ASSET_DISPOSAL_VALIDATION'));
    await assert.rejects(() => assetsService.disposeAsset(asset.id, { ...base, disposalValue: undefined }, approver, transaction), expectCode('ASSET_DISPOSAL_VALUE_REQUIRED'));
    await assert.rejects(() => assetsService.disposeAsset(asset.id, { ...base, disposalValue: 0 }, approver, transaction), expectCode('ASSET_DISPOSAL_VALUE_REQUIRED'));
    await assert.rejects(() => assetsService.disposeAsset(asset.id, { ...base, disposalValue: 'NaN' }, approver, transaction), expectCode('ASSET_DISPOSAL_VALIDATION'));
    await assert.rejects(() => assetsService.disposeAsset(asset.id, { ...base, disposalValue: -5 }, approver, transaction), expectCode('ASSET_DISPOSAL_VALIDATION'));
    await assert.rejects(() => assetsService.disposeAsset(asset.id, { ...base, disposalType: 'DONATION' }, approver, transaction), expectCode('ASSET_DISPOSAL_VALIDATION'));
    await assert.rejects(() => assetsService.disposeAsset(asset.id, { ...base, reason: '   ' }, approver, transaction), expectCode('ASSET_DISPOSAL_REASON_REQUIRED'));
    await assert.rejects(() => assetsService.disposeAsset(asset.id, { ...base, evidenceFileIds: [] }, approver, transaction), expectCode('ASSET_DISPOSAL_EVIDENCE_REQUIRED'));
    await assert.rejects(() => assetsService.disposeAsset(asset.id, { ...base, evidenceFileIds: ['nao-e-uuid'] }, approver, transaction), expectCode('ASSET_DISPOSAL_VALIDATION'));
    await assert.rejects(
      () => assetsService.disposeAsset(asset.id, { ...base, evidenceFileIds: ['00000000-0000-4000-8000-000000000000'] }, approver, transaction),
      expectCode('ASSET_DISPOSAL_EVIDENCE_NOT_FOUND')
    );

    await asset.reload({ transaction });
    assert.equal(asset.status, 'AVAILABLE', 'nenhuma tentativa inválida pode ter baixado o asset');
  });
});

test('Gap 3 (§9): doação sem valor é aceita', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);
    const evidence = await createEvidence(transaction);
    const result = await assetsService.disposeAsset(asset.id, { disposalType: 'DONATION', reason: 'Doado à ONG X (termo anexo).', evidenceFileIds: [evidence.id] }, approver, transaction);
    assert.equal(result.asset.status, 'DISPOSED');
    assert.equal(result.financialEntry, null);
  });
});

test('Gap 3 (§9): não baixa ferramenta emprestada — exige devolução antes', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);
    const destination = await createLocation(transaction);
    const evidence = await createEvidence(transaction);
    await toolLoansService.loanTool(asset.id, { personUserId: tenant.userId, destinationLocationId: destination.id }, tenant.userId, transaction);
    await assert.rejects(
      () => assetsService.disposeAsset(asset.id, { disposalType: 'DISCARD', reason: 'x', evidenceFileIds: [evidence.id] }, approver, transaction),
      expectCode('ASSET_DISPOSAL_ASSET_LOANED')
    );
  });
});

test('Gap 3 (§9): não baixa patrimônio com OS de manutenção OPEN — exige fechamento antes', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);
    const evidence = await createEvidence(transaction);
    const order = await maintenanceService.openMaintenanceOrder(withTenant({ assetId: asset.id, description: 'Revisão.' }), tenant.userId, transaction);
    await assert.rejects(
      () => assetsService.disposeAsset(asset.id, { disposalType: 'DISCARD', reason: 'x', evidenceFileIds: [evidence.id] }, approver, transaction),
      expectCode('ASSET_DISPOSAL_MAINTENANCE_OPEN')
    );
    await maintenanceService.closeMaintenanceOrder(order.id, tenant.userId, transaction);
    const result = await assetsService.disposeAsset(asset.id, { disposalType: 'DISCARD', reason: 'Sem conserto.', evidenceFileIds: [evidence.id] }, approver, transaction);
    assert.equal(result.asset.status, 'DISPOSED', 'depois de fechar a OS, a baixa é permitida');
  });
});

test('Gap 3 (§9): não baixa patrimônio com caso de perda OPEN', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);
    const evidence = await createEvidence(transaction);
    await lossCasesService.openLossCase(withTenant({ assetId: asset.id, context: 'Sumiu do canteiro.', evidenceFileIds: [evidence.id] }), tenant.userId, transaction);
    await assert.rejects(
      () => assetsService.disposeAsset(asset.id, { disposalType: 'DISCARD', reason: 'x', evidenceFileIds: [evidence.id] }, approver, transaction),
      expectCode('ASSET_DISPOSAL_LOSS_CASE_OPEN')
    );
  });
});

test('Gap 3 (§9): patrimônio baixado é terminal — não pode ser baixado de novo, emprestado, transferido, ir pra manutenção nem virar perda', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);
    const destination = await createLocation(transaction);
    const evidence = await createEvidence(transaction);
    await assetsService.disposeAsset(asset.id, { disposalType: 'DISCARD', reason: 'Fim de vida útil.', evidenceFileIds: [evidence.id] }, approver, transaction);

    await assert.rejects(
      () => assetsService.disposeAsset(asset.id, { disposalType: 'DISCARD', reason: 'de novo', evidenceFileIds: [evidence.id] }, approver, transaction),
      expectCode('ASSET_ALREADY_DISPOSED')
    );
    await assert.rejects(
      () => toolLoansService.loanTool(asset.id, { personUserId: tenant.userId, destinationLocationId: destination.id }, tenant.userId, transaction),
      expectCode('TOOL_LOAN_ASSET_UNAVAILABLE')
    );
    await assert.rejects(
      () => assetsService.transferAsset(asset.id, { destinationLocationId: destination.id }, tenant.userId, transaction),
      expectCode('ASSET_NOT_IN_CIRCULATION')
    );
    await assert.rejects(
      () => maintenanceService.openMaintenanceOrder(withTenant({ assetId: asset.id, description: 'x' }), tenant.userId, transaction),
      expectCode('MAINTENANCE_ASSET_DISPOSED')
    );
    await assert.rejects(
      () => lossCasesService.openLossCase(withTenant({ assetId: asset.id, context: 'x', evidenceFileIds: [evidence.id] }), tenant.userId, transaction),
      expectCode('LOSS_CASE_ASSET_DISPOSED')
    );
  });
});

test('Gap 3 (§9): transferAsset recusa idempotencyKey com o prefixo reservado da baixa', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);
    const destination = await createLocation(transaction);
    await assert.rejects(
      () => assetsService.transferAsset(asset.id, { destinationLocationId: destination.id, idempotencyKey: `asset-disposal:${asset.id}` }, tenant.userId, transaction),
      expectCode('ASSET_TRANSFER_VALIDATION')
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Gap 4 — Caderno §10: freeze lógico durante inventário físico
// ---------------------------------------------------------------------------------------------

test('Gap 4 (§10): com contagem OPEN, qualquer movimento tocando o local é bloqueado; outros locais seguem livres; fechar libera', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const frozen = await createLocation(transaction);
    const other = await createLocation(transaction);
    const item = await createItem(transaction);

    await movementsService.recordMovement(withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 10, destinationLocationId: frozen.id }), approver, transaction);
    await movementsService.recordMovement(withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 5, destinationLocationId: other.id }), approver, transaction);

    const count = await countsService.openCount(withTenant({ locationId: frozen.id }), tenant.userId, transaction);

    for (const payload of [
      { movementType: 'IN', quantity: 1, destinationLocationId: frozen.id },
      { movementType: 'OUT', quantity: 1, sourceLocationId: frozen.id },
      { movementType: 'TRANSFER', quantity: 1, sourceLocationId: frozen.id, destinationLocationId: other.id },
      { movementType: 'TRANSFER', quantity: 1, sourceLocationId: other.id, destinationLocationId: frozen.id },
      { movementType: 'ADJUSTMENT', quantity: 1, destinationLocationId: frozen.id, reason: 'ajuste manual' },
    ]) {
      await assert.rejects(
        () => movementsService.recordMovement(withTenant({ inventoryItemId: item.id, ...payload }), approver, transaction),
        expectCode('INVENTORY_LOCATION_FROZEN_BY_COUNT'),
        `movimento ${payload.movementType} tocando o local em contagem precisa ser bloqueado`
      );
    }

    // Local sem contagem continua movimentando normalmente.
    await movementsService.recordMovement(withTenant({ inventoryItemId: item.id, movementType: 'OUT', quantity: 2, sourceLocationId: other.id }), approver, transaction);

    // Esperado no fechamento == saldo na abertura (10), divergência só reflete a contagem.
    await countsService.addCountItem(count.id, { inventoryItemId: item.id, countedQuantity: 8 }, transaction);
    const completed = await countsService.completeCount(count.id, tenant.userId, transaction);
    const line = completed.items.find((l) => l.inventoryItemId === item.id);
    assert.equal(Number(line.expectedQuantity), 10);
    assert.equal(Number(line.divergence), -2);

    // Fechada a contagem, o local volta a aceitar movimentos (incluindo o ajuste da divergência).
    const adjusted = await countsService.applyAdjustment(line.id, approver, transaction);
    assert.ok(adjusted.adjustmentMovementId);
    await movementsService.recordMovement(withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 1, destinationLocationId: frozen.id }), approver, transaction);
    assert.equal(await movementsService.getBalance(item.id, frozen.id, transaction), 9);
  });
});

test('Gap 4 (§10): baixa de requisição a partir de almoxarifado em contagem é bloqueada (freeze vale pra todo fluxo que gera movimento)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const warehouse = await createLocation(transaction);
    const item = await createItem(transaction);
    await movementsService.recordMovement(withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 10, destinationLocationId: warehouse.id }), approver, transaction);
    const requisition = await requisitionsService.createRequisition(
      withTenant({ warehouseLocationId: warehouse.id, items: [{ inventoryItemId: item.id, quantity: 3 }] }),
      tenant.userId,
      transaction
    );
    await requisitionsService.decideRequisition(requisition.id, 'APPROVED', tenant.userId, transaction);
    await countsService.openCount(withTenant({ locationId: warehouse.id }), tenant.userId, transaction);

    await assert.rejects(() => requisitionsService.issueRequisition(requisition.id, approver, transaction), expectCode('INVENTORY_LOCATION_FROZEN_BY_COUNT'));
    assert.equal(await movementsService.getBalance(item.id, warehouse.id, transaction), 10);
  });
});

test('Gap 4 (§10): reenvio idempotente de movimento gravado ANTES da contagem devolve o original (não é movimento novo)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const location = await createLocation(transaction);
    const item = await createItem(transaction);
    const key = `gap4-idem-${uniqueSuffix()}`;
    const payload = withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 4, destinationLocationId: location.id, idempotencyKey: key });
    const original = await movementsService.recordMovement(payload, approver, transaction);
    await countsService.openCount(withTenant({ locationId: location.id }), tenant.userId, transaction);
    const replay = await movementsService.recordMovement(payload, approver, transaction);
    assert.equal(replay.id, original.id);
    assert.equal(await movementsService.getBalance(item.id, location.id, transaction), 4);
  });
});

test('Gap 4 (§10): não é possível abrir duas contagens OPEN no mesmo local; local inexistente é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const location = await createLocation(transaction);
    await countsService.openCount(withTenant({ locationId: location.id }), tenant.userId, transaction);
    await assert.rejects(() => countsService.openCount(withTenant({ locationId: location.id }), tenant.userId, transaction), expectCode('INVENTORY_COUNT_ALREADY_OPEN'));
    await assert.rejects(
      () => countsService.openCount(withTenant({ locationId: '00000000-0000-4000-8000-000000000000' }), tenant.userId, transaction),
      expectCode('INVENTORY_LOCATION_NOT_FOUND')
    );
  });
});

// Corrida real entre transações distintas (commit de verdade), mesmo padrão de
// withCommittedTenantTransaction de procurement.cycle1.test.js. Fixtures mínimas criadas direto
// pelo model (sem outbox/auditoria) e removidas no finally.
async function openTenantTransaction() {
  const t = await sequelize.transaction();
  await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
  await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
  await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
  return t;
}

async function withCommitted(fn) {
  const t = await openTenantTransaction();
  try {
    const result = await fn(t);
    await t.commit();
    return result;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function createCommittedFixtures() {
  const suffix = uniqueSuffix();
  return withCommitted(async (t) => {
    const location = await InventoryLocation.create(withTenant({ name: `GAP4 RACE ${suffix}`, locationType: 'WAREHOUSE' }), { transaction: t });
    const item = await InventoryItem.create(withTenant({ name: `GAP4 RACE item ${suffix}`, sku: `GAP4R-${suffix}`, unitOfMeasure: 'UN' }), { transaction: t });
    return { location, item };
  });
}

async function cleanupCommittedFixtures({ location, item }) {
  await withCommitted(async (t) => {
    // Nenhum movimento é comitado nestes testes (todas as transações de movimento fazem
    // rollback), então só a contagem e as fixtures precisam ser removidas.
    await InventoryCount.destroy({ where: { locationId: location.id }, transaction: t });
    await InventoryItem.destroy({ where: { id: item.id }, force: true, transaction: t });
    await InventoryLocation.destroy({ where: { id: location.id }, force: true, transaction: t });
  });
}

test('Gap 4 (§10) concorrência: movimento que chega enquanto a contagem está sendo aberta espera o commit e é bloqueado', async () => {
  const fixtures = await createCommittedFixtures();
  const { location, item } = fixtures;
  let countTx = null;
  let movementTx = null;
  try {
    countTx = await openTenantTransaction();
    await countsService.openCount(withTenant({ locationId: location.id }), tenant.userId, countTx);

    movementTx = await openTenantTransaction();
    let settled = false;
    const movementPromise = movementsService
      .recordMovement(withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 7, destinationLocationId: location.id }), approver, movementTx)
      .finally(() => { settled = true; });
    movementPromise.catch(() => {});

    // O movimento precisa ficar esperando o lock do local (FOR SHARE x FOR UPDATE da abertura).
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(settled, false, 'movimento não pode passar enquanto a abertura da contagem no mesmo local está em voo');

    await countTx.commit();
    countTx = null;

    await assert.rejects(() => movementPromise, expectCode('INVENTORY_LOCATION_FROZEN_BY_COUNT'));
    await movementTx.rollback();
    movementTx = null;

    const committedMovements = await withCommitted((t) => InventoryMovement.count({ where: { inventoryItemId: item.id }, transaction: t }));
    assert.equal(committedMovements, 0, 'nenhum movimento pode ter entrado no local congelado');
  } finally {
    if (countTx) await countTx.rollback().catch(() => {});
    if (movementTx) await movementTx.rollback().catch(() => {});
    await cleanupCommittedFixtures(fixtures);
  }
});

test('Gap 4 (§10) concorrência: abertura de contagem espera movimentos em voo no mesmo local', async () => {
  const fixtures = await createCommittedFixtures();
  const { location, item } = fixtures;
  let movementTx = null;
  let countTx = null;
  try {
    movementTx = await openTenantTransaction();
    await movementsService.recordMovement(withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 3, destinationLocationId: location.id }), approver, movementTx);

    // Abertura concorrente precisa esperar o lock — com lock_timeout curto, o timeout prova que
    // ela não passa por cima de um movimento ainda não comitado.
    countTx = await openTenantTransaction();
    await sequelize.query("SET LOCAL lock_timeout = '1500ms'", { transaction: countTx });
    await assert.rejects(
      () => countsService.openCount(withTenant({ locationId: location.id }), tenant.userId, countTx),
      (err) => {
        const code = err?.parent?.code || err?.original?.code;
        assert.equal(code, '55P03', `esperava lock_not_available (55P03), veio: ${err?.message}`);
        return true;
      }
    );
  } finally {
    if (countTx) await countTx.rollback().catch(() => {});
    if (movementTx) await movementTx.rollback().catch(() => {});
    await cleanupCommittedFixtures(fixtures);
  }
});
