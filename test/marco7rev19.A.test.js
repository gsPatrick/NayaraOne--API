'use strict';

// Revisão independente do Marco 7 (19/10/2026, Maturacao/REVISAO_MARCO7_19-10.md), seção A —
// Estoque, Ferramentas e Patrimônio. Cada teste foi escrito ANTES da correção e falhava no
// código anterior (ver relatório). Postgres real, NODE_ENV=test, tudo dentro de
// withRollbackTenantTransaction (nada persiste no banco compartilhado). A concorrência do A9
// (duas conexões) fica em marco7rev19.A9concurrency.test.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const movementsService = require('../src/features/inventory/movements.service');
const receiptsService = require('../src/features/inventory/receipts.service');
const requisitionsService = require('../src/features/inventory/requisitions.service');
const lossCasesService = require('../src/features/inventory/lossCases.service');
const toolLoansService = require('../src/features/inventory/toolLoans.service');
const assetsService = require('../src/features/inventory/assets.service');
const countsService = require('../src/features/inventory/counts.service');
const filesService = require('../src/features/files/files.service');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const { getProjectHealth } = require('../src/features/construction/projectHealth.service');
const { getConstructionDashboard } = require('../src/features/construction/dashboard.service');
const {
  User,
  Person,
  InventoryItem,
  InventoryMovement,
  InventoryLossCase,
  InventoryLocation,
  InventoryCount,
  InventoryStockBalance,
  ApprovalThreshold,
} = require('../src/models');
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

function expectCode(code) {
  return (err) => {
    assert.ok(err instanceof AppError, `esperado AppError(${code}), recebido: ${err?.name} ${err?.code} ${err?.message}`);
    assert.equal(err.code, code, `código esperado ${code}, recebido ${err.code}: ${err.message}`);
    return true;
  };
}

const admin = () => ({ userId: tenant.userId, canApprove: true });

async function otherUser(label) {
  const suffix = uniqueSuffix();
  const [user] = await User.findOrCreate({
    where: { email: `homo-qa-rev19-${label}-${suffix}@nayaraone.dev` },
    defaults: { name: `HOMO QA rev19 ${label} ${suffix}`, passwordHash: 'x', status: 'ACTIVE' },
  });
  return { userId: user.id, canApprove: true };
}

async function person(transaction, label = 'Responsável') {
  return Person.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `${label} rev19 ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction }
  );
}

async function evidence(transaction) {
  return filesService.uploadFile(
    withTenant({ fileName: 'evidencia-rev19.jpg', mimeType: 'image/jpeg', contentBase64: Buffer.from(`EVID-${uniqueSuffix()}`).toString('base64'), category: 'generic' }),
    tenant.userId,
    transaction
  );
}

async function item(transaction, extra = {}) {
  const suffix = uniqueSuffix();
  return itemsService.createItem(withTenant({ name: `HOMO QA rev19 Item ${suffix}`, sku: `REV19-${suffix}`, unitOfMeasure: 'UN', ...extra }), tenant.userId, transaction);
}

async function warehouse(transaction) {
  return itemsService.createLocation(withTenant({ name: `HOMO QA rev19 Almox ${uniqueSuffix()}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);
}

async function projectWithSite(transaction) {
  const project = await projectsService.createProject(withTenant({ name: `HOMO QA rev19 Obra ${uniqueSuffix()}` }), tenant.userId, transaction);
  const stage = await projectStagesService.createProjectStage(project.id, withTenant({ name: 'Fundação' }), tenant.userId, transaction);
  const site = await itemsService.createLocation(
    withTenant({ name: `HOMO QA rev19 Canteiro ${uniqueSuffix()}`, locationType: 'PROJECT_SITE', projectId: project.id }),
    tenant.userId,
    transaction
  );
  return { project, stage, site };
}

async function receive(transaction, itemId, locationId, quantity, unitCost) {
  const receipt = await receiptsService.createReceipt(withTenant({ destinationLocationId: locationId, items: [{ inventoryItemId: itemId, quantity, unitCost }] }), tenant.userId, transaction);
  await receiptsService.reviewReceipt(receipt.id, tenant.userId, tenant.groupId, tenant.companyId, transaction);
  await receiptsService.confirmReceipt(receipt.id, admin(), tenant.groupId, tenant.companyId, transaction);
}

async function issueToProject(transaction, { itemId, warehouseId, project, stage, site, quantity, responsible }) {
  const requisition = await requisitionsService.createRequisition(
    withTenant({ warehouseLocationId: warehouseId, projectLocationId: site.id, projectId: project.id, stageId: stage.id, items: [{ inventoryItemId: itemId, quantity }] }),
    tenant.userId,
    transaction
  );
  const approver = await otherUser('req-approver');
  await requisitionsService.decideRequisition(requisition.id, 'APPROVED', approver.userId, tenant.groupId, tenant.companyId, transaction);
  return requisitionsService.issueRequisition(requisition.id, admin(), tenant.groupId, tenant.companyId, transaction, { responsiblePersonId: responsible.id });
}

// =============================================================================================
// A1 (EST-011): custo levado à obra é o custo HISTÓRICO do movimento, nunca o custo médio de hoje.
// =============================================================================================

test('A1: OUT grava unit_cost/total_cost no momento do fato e o custo da obra não muda quando o custo médio sobe depois', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const it = await item(transaction);
    const wh = await warehouse(transaction);
    const { project, stage, site } = await projectWithSite(transaction);
    const resp = await person(transaction);

    await receive(transaction, it.id, wh.id, 10, 10); // custo médio 10
    await issueToProject(transaction, { itemId: it.id, warehouseId: wh.id, project, stage, site, quantity: 4, responsible: resp });

    const out = await InventoryMovement.findOne({ where: { inventoryItemId: it.id, movementType: 'OUT' }, transaction });
    assert.equal(Number(out.unitCost), 10, 'unit_cost gravado no OUT = custo médio do momento da saída');
    assert.equal(Number(out.totalCost), 40, 'total_cost gravado no OUT = 4 × 10');

    const before = await getProjectHealth(project.id, transaction);
    assert.equal(before.consumedInventoryCost, 40);

    await receive(transaction, it.id, wh.id, 10, 30); // custo médio da empresa (almoxarifado 6 + canteiro 4) sobe para (10×10 + 10×30)/20 = 20
    const refreshed = await InventoryItem.findByPk(it.id, { transaction });
    assert.equal(Number(refreshed.averageCost), 20);

    const afterHealth = await getProjectHealth(project.id, transaction);
    assert.equal(afterHealth.consumedInventoryCost, 40, 'histórico não pode mudar porque o custo médio de hoje mudou');
  });
});

test('A1: devolução do canteiro ao almoxarifado (TRANSFER) abate da obra ao custo pelo qual foi levado; perda no canteiro não cobra duas vezes; ajuste positivo no canteiro entra na obra; painel agregado = drill-down', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const it = await item(transaction);
    const wh = await warehouse(transaction);
    const { project, stage, site } = await projectWithSite(transaction);
    const resp = await person(transaction);
    const dashBefore = await getConstructionDashboard({ groupId: tenant.groupId, companyId: tenant.companyId }, transaction);

    await receive(transaction, it.id, wh.id, 10, 10);
    await issueToProject(transaction, { itemId: it.id, warehouseId: wh.id, project, stage, site, quantity: 4, responsible: resp }); // +40
    await receive(transaction, it.id, wh.id, 10, 30); // custo médio 20

    // Volta 1 unidade do canteiro para o almoxarifado: abate 10 (custo pelo qual foi levada), não 20.
    await movementsService.recordMovement(
      withTenant({ inventoryItemId: it.id, movementType: 'TRANSFER', quantity: 1, sourceLocationId: site.id, destinationLocationId: wh.id, reason: 'Sobra devolvida' }),
      admin(),
      transaction
    );
    let health = await getProjectHealth(project.id, transaction);
    assert.equal(health.consumedInventoryCost, 30, 'TRANSFER canteiro → almoxarifado abate 1 × 10');

    // Perda no canteiro (caso aprovado por outra pessoa): o material já foi cobrado da obra na entrada — não cobra de novo.
    const file = await evidence(transaction);
    const lossCase = await lossCasesService.openLossCase(
      withTenant({ inventoryItemId: it.id, locationId: site.id, projectId: project.id, quantity: 1, context: 'Quebrou no canteiro', evidenceFileIds: [file.id] }),
      tenant.userId,
      transaction
    );
    await lossCasesService.decideLossCase(lossCase.id, tenant.groupId, tenant.companyId, 'APPROVED', await otherUser('loss-approver'), transaction);
    health = await getProjectHealth(project.id, transaction);
    assert.equal(health.consumedInventoryCost, 30, 'LOSS no canteiro é material já levado à obra — sem cobrança dupla');
    const lossMovement = await InventoryMovement.findOne({ where: { inventoryItemId: it.id, movementType: 'LOSS' }, transaction });
    assert.ok(lossMovement.unitCost != null && lossMovement.totalCost != null, 'LOSS também guarda custo histórico');

    // Ajuste positivo no canteiro (sobra encontrada, aprovada por outra pessoa): material entra na custódia da obra ao custo de hoje (20).
    const proposal = await movementsService.proposeAdjustment(
      withTenant({ inventoryItemId: it.id, movementType: 'ADJUSTMENT', quantity: 2, destinationLocationId: site.id, reason: 'Sobra encontrada na conferência do canteiro', idempotencyKey: `rev19-a1-adj-${uniqueSuffix()}` }),
      { userId: tenant.userId, canApprove: true },
      transaction
    );
    await movementsService.decideAdjustmentProposal(proposal.id, tenant.groupId, tenant.companyId, 'APPROVED', await otherUser('adj-approver'), transaction);
    health = await getProjectHealth(project.id, transaction);
    assert.equal(health.consumedInventoryCost, 70, '30 + 2 × 20');

    const dashAfter = await getConstructionDashboard({ groupId: tenant.groupId, companyId: tenant.companyId }, transaction);
    const delta = Math.round((dashAfter.obras.consumedInventoryCostTotal - dashBefore.obras.consumedInventoryCostTotal) * 100) / 100;
    assert.equal(delta, 70, 'painel agregado usa exatamente a mesma conta do drill-down por obra');
  });
});

// =============================================================================================
// A2 (EST-010): custo do caso de perda é calculado no servidor; nunca autoaprova.
// =============================================================================================

test('A2: estimatedCost enviado pelo cliente (negativo ou subavaliado) é ignorado — o servidor calcula quantidade × custo médio', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const it = await item(transaction);
    const wh = await warehouse(transaction);
    await receive(transaction, it.id, wh.id, 10, 25);
    const file = await evidence(transaction);
    const lossCase = await lossCasesService.openLossCase(
      withTenant({ inventoryItemId: it.id, locationId: wh.id, quantity: 3, context: 'Extravio', evidenceFileIds: [file.id], estimatedCost: -999 }),
      tenant.userId,
      transaction
    );
    assert.equal(Number(lossCase.estimatedCost), 75, '3 × 25, calculado no servidor');
  });
});

test('A2: com alçada configurada, valor subavaliado pelo cliente NÃO autoaprova — toda perda exige decisão de outra pessoa', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await ApprovalThreshold.destroy({ where: { companyId: tenant.companyId, context: 'INVENTORY_LOSS' }, transaction });
    await ApprovalThreshold.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, context: 'INVENTORY_LOSS', maxAutoApproveAmount: 500 },
      { transaction }
    );
    const it = await item(transaction);
    const wh = await warehouse(transaction);
    await receive(transaction, it.id, wh.id, 100, 1000);
    const file = await evidence(transaction);

    const big = await lossCasesService.openLossCase(
      withTenant({ inventoryItemId: it.id, locationId: wh.id, quantity: 30, context: 'Furto', evidenceFileIds: [file.id], estimatedCost: 1 }),
      tenant.userId,
      transaction
    );
    assert.equal(big.status, 'PENDING_APPROVAL', 'R$ 30.000 real (não R$ 1 declarado) fica acima da alçada');
    assert.equal(big.resultingMovementId, null);

    const small = await lossCasesService.openLossCase(
      withTenant({ inventoryItemId: it.id, locationId: wh.id, quantity: 0.1, context: 'Avaria pequena', evidenceFileIds: [file.id] }),
      tenant.userId,
      transaction
    );
    assert.notEqual(small.status, 'APPROVED', 'mesmo abaixo da alçada a perda não se autoaprova');
    assert.equal(await InventoryMovement.count({ where: { inventoryItemId: it.id, movementType: 'LOSS' }, transaction }), 0);
  });
});

test('A2: perda de patrimônio usa o valor contábil do servidor (valor de aquisição depreciado), não o informado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await assetsService.createAsset(
      withTenant({ name: `HOMO QA rev19 Gerador ${uniqueSuffix()}`, assetTag: `REV19A2-${uniqueSuffix()}`, acquisitionValue: 1200, acquiredAt: new Date().toISOString() }),
      tenant.userId,
      transaction
    );
    const file = await evidence(transaction);
    const lossCase = await lossCasesService.openLossCase(
      withTenant({ assetId: asset.id, context: 'Sumiu da obra', evidenceFileIds: [file.id], estimatedCost: -5 }),
      tenant.userId,
      transaction
    );
    assert.ok(Number(lossCase.estimatedCost) > 1190 && Number(lossCase.estimatedCost) <= 1200, `valor contábil ~1200, recebido ${lossCase.estimatedCost}`);
  });
});

// =============================================================================================
// A3 (EST-006): dueAt obrigatório, futuro e com limite máximo.
// =============================================================================================

async function loanFixture(transaction) {
  const wh = await warehouse(transaction);
  const dest = await warehouse(transaction);
  const asset = await assetsService.createAsset(
    withTenant({ name: `HOMO QA rev19 Furadeira ${uniqueSuffix()}`, assetTag: `REV19A3-${uniqueSuffix()}`, currentLocationId: wh.id }),
    tenant.userId,
    transaction
  );
  return { asset, dest };
}

for (const [label, dueAt] of [
  ['ausente', undefined],
  ['no passado', new Date(Date.now() - 24 * 3600 * 1000).toISOString()],
  ['acima do limite máximo (400 dias)', new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString()],
  ['inválido', 'amanhã'],
]) {
  test(`A3: empréstimo de ferramenta com dueAt ${label} é recusado`, async () => {
    await withRollbackTenantTransaction(tenant, async (transaction) => {
      const { asset, dest } = await loanFixture(transaction);
      await assert.rejects(
        () => toolLoansService.loanTool(asset.id, { personUserId: tenant.userId, destinationLocationId: dest.id, dueAt }, tenant.userId, tenant.groupId, tenant.companyId, transaction),
        expectCode('TOOL_LOAN_DUE_AT_INVALID')
      );
    });
  });
}

test('A3 (controle positivo): dueAt futuro dentro do limite é aceito', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { asset, dest } = await loanFixture(transaction);
    const dueAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const loan = await toolLoansService.loanTool(asset.id, { conditionOutCode: 'OK', personUserId: tenant.userId, destinationLocationId: dest.id, dueAt }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    assert.ok(loan.dueAt);
  });
});

// =============================================================================================
// A4: um patrimônio só pode ter um caso de perda aberto (serviço + índice único parcial).
// =============================================================================================

test('A4: segundo caso de perda aberto para o mesmo patrimônio é recusado (409)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await assetsService.createAsset(withTenant({ name: `HOMO QA rev19 Betoneira ${uniqueSuffix()}`, assetTag: `REV19A4-${uniqueSuffix()}` }), tenant.userId, transaction);
    const file = await evidence(transaction);
    await lossCasesService.openLossCase(withTenant({ assetId: asset.id, context: 'Sumiu', evidenceFileIds: [file.id] }), tenant.userId, transaction);
    await assert.rejects(
      () => lossCasesService.openLossCase(withTenant({ assetId: asset.id, context: 'Sumiu (de novo)', evidenceFileIds: [file.id] }), tenant.userId, transaction),
      (err) => expectCode('LOSS_CASE_ALREADY_OPEN')(err) && err.statusCode === 409
    );
  });
});

test('A4: índice único parcial no banco impede o segundo caso aberto mesmo fora do serviço', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await assetsService.createAsset(withTenant({ name: `HOMO QA rev19 Serra ${uniqueSuffix()}`, assetTag: `REV19A4B-${uniqueSuffix()}` }), tenant.userId, transaction);
    const base = { groupId: tenant.groupId, companyId: tenant.companyId, assetId: asset.id, context: 'x', evidenceFileIds: [], createdBy: tenant.userId };
    await InventoryLossCase.create({ ...base, status: 'OPEN' }, { transaction });
    await assert.rejects(
      () => InventoryLossCase.create({ ...base, status: 'PENDING_APPROVAL' }, { transaction }),
      (err) => err.name === 'SequelizeUniqueConstraintError' || err?.parent?.code === '23505'
    );
  });
});

// =============================================================================================
// A5: caso em PENDING_APPROVAL também bloqueia empréstimo e baixa.
// =============================================================================================

async function assetWithPendingLossCase(transaction) {
  const wh = await warehouse(transaction);
  const asset = await assetsService.createAsset(withTenant({ name: `HOMO QA rev19 Martelete ${uniqueSuffix()}`, assetTag: `REV19A5-${uniqueSuffix()}`, currentLocationId: wh.id }), tenant.userId, transaction);
  const file = await evidence(transaction);
  const lossCase = await lossCasesService.openLossCase(withTenant({ assetId: asset.id, context: 'Sumiu', evidenceFileIds: [file.id] }), tenant.userId, transaction);
  await InventoryLossCase.update({ status: 'PENDING_APPROVAL' }, { where: { id: lossCase.id }, transaction });
  return { asset, wh };
}

test('A5: patrimônio com caso de perda PENDING_APPROVAL não pode ser emprestado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { asset } = await assetWithPendingLossCase(transaction);
    const dest = await warehouse(transaction);
    await assert.rejects(
      () => toolLoansService.loanTool(asset.id, { conditionOutCode: 'OK', personUserId: tenant.userId, destinationLocationId: dest.id, dueAt: new Date(Date.now() + 86400000).toISOString() }, tenant.userId, tenant.groupId, tenant.companyId, transaction),
      expectCode('TOOL_LOAN_LOSS_CASE_OPEN')
    );
  });
});

test('A5: patrimônio com caso de perda PENDING_APPROVAL não pode ser baixado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { asset } = await assetWithPendingLossCase(transaction);
    const file = await evidence(transaction);
    const disposer = await otherUser('dispose');
    await assert.rejects(
      () => assetsService.disposeAsset(asset.id, tenant.groupId, tenant.companyId, { disposalType: 'DISCARD', reason: 'Sucata', evidenceFileIds: [file.id] }, disposer, transaction),
      (err) => err instanceof AppError && err.code === 'ASSET_DISPOSAL_LOSS_CASE_OPEN'
    );
  });
});

// =============================================================================================
// A6 (EST-008): ajuste manual é proposta aprovada por OUTRA pessoa.
// =============================================================================================

test('A6: ADJUSTMENT/DISPOSAL manual direto no ledger é recusado mesmo com inventory:approve', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const it = await item(transaction);
    const wh = await warehouse(transaction);
    await assert.rejects(
      () => movementsService.recordMovement(
        withTenant({ inventoryItemId: it.id, movementType: 'ADJUSTMENT', quantity: 5, destinationLocationId: wh.id, reason: 'Sobra', idempotencyKey: `rev19-a6-${uniqueSuffix()}` }),
        admin(),
        transaction
      ),
      expectCode('INVENTORY_ADJUSTMENT_REQUIRES_PROPOSAL')
    );
    assert.equal(await movementsService.getBalance(it.id, wh.id, tenant.groupId, tenant.companyId, transaction), 0);
  });
});

test('A6: quem propôs o ajuste não aprova; outra pessoa aprova e só então o movimento é gravado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const it = await item(transaction);
    const wh = await warehouse(transaction);
    const proposal = await movementsService.proposeAdjustment(
      withTenant({ inventoryItemId: it.id, movementType: 'ADJUSTMENT', quantity: 5, destinationLocationId: wh.id, reason: 'Sobra encontrada', idempotencyKey: `rev19-a6b-${uniqueSuffix()}` }),
      admin(),
      transaction
    );
    assert.equal(proposal.status, 'PENDING');
    assert.equal(await movementsService.getBalance(it.id, wh.id, tenant.groupId, tenant.companyId, transaction), 0, 'proposta não mexe no saldo');

    await assert.rejects(
      () => movementsService.decideAdjustmentProposal(proposal.id, tenant.groupId, tenant.companyId, 'APPROVED', admin(), transaction),
      expectCode('INVENTORY_ADJUSTMENT_SELF_APPROVAL_BLOCKED')
    );
    const semPerm = await otherUser('sem-perm');
    await assert.rejects(
      () => movementsService.decideAdjustmentProposal(proposal.id, tenant.groupId, tenant.companyId, 'APPROVED', { userId: semPerm.userId, canApprove: false }, transaction),
      expectCode('INVENTORY_MOVEMENT_APPROVAL_REQUIRED')
    );

    const decided = await movementsService.decideAdjustmentProposal(proposal.id, tenant.groupId, tenant.companyId, 'APPROVED', await otherUser('adj-ok'), transaction);
    assert.equal(decided.status, 'APPROVED');
    assert.ok(decided.resultingMovementId);
    const mv = await InventoryMovement.findByPk(decided.resultingMovementId, { transaction });
    assert.equal(mv.sourceType, 'ADJUSTMENT_PROPOSAL');
    assert.equal(mv.sourceId, proposal.id);
    assert.equal(await movementsService.getBalance(it.id, wh.id, tenant.groupId, tenant.companyId, transaction), 5);

    const second = await otherUser('adj-2x');
    await assert.rejects(
      () => movementsService.decideAdjustmentProposal(proposal.id, tenant.groupId, tenant.companyId, 'APPROVED', second, transaction),
      expectCode('INVENTORY_ADJUSTMENT_INVALID_TRANSITION')
    );
  });
});

// =============================================================================================
// A7 (EST-004 / §5): OUT para a obra exige etapa (e responsável).
// =============================================================================================

test('A7: OUT do canteiro (consumo na obra) sem stageId é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const it = await item(transaction);
    const { site } = await projectWithSite(transaction);
    const resp = await person(transaction);
    await movementsService.recordMovement(withTenant({ inventoryItemId: it.id, movementType: 'IN', quantity: 5, destinationLocationId: site.id }), admin(), transaction);
    await assert.rejects(
      () => movementsService.recordMovement(withTenant({ inventoryItemId: it.id, movementType: 'OUT', quantity: 1, sourceLocationId: site.id, responsiblePersonId: resp.id, reason: 'Consumo' }), admin(), transaction),
      expectCode('INVENTORY_MOVEMENT_STAGE_REQUIRED')
    );
  });
});

test('A7: OUT do almoxarifado vinculado a obra sem stageId é recusado; etapa de outra obra também', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const it = await item(transaction);
    const wh = await warehouse(transaction);
    const { project } = await projectWithSite(transaction);
    const { stage: foreignStage } = await projectWithSite(transaction);
    const resp = await person(transaction);
    await movementsService.recordMovement(withTenant({ inventoryItemId: it.id, movementType: 'IN', quantity: 5, destinationLocationId: wh.id }), admin(), transaction);
    await assert.rejects(
      () => movementsService.recordMovement(withTenant({ inventoryItemId: it.id, movementType: 'OUT', quantity: 1, sourceLocationId: wh.id, projectId: project.id, responsiblePersonId: resp.id }), admin(), transaction),
      expectCode('INVENTORY_MOVEMENT_STAGE_REQUIRED')
    );
    await assert.rejects(
      () => movementsService.recordMovement(withTenant({ inventoryItemId: it.id, movementType: 'OUT', quantity: 1, sourceLocationId: wh.id, projectId: project.id, stageId: foreignStage.id, responsiblePersonId: resp.id }), admin(), transaction),
      expectCode('INVENTORY_MOVEMENT_STAGE_INVALID')
    );
  });
});

test('A7: requisição para obra sem etapa é recusada na criação; entrega exige responsável e grava OUT com obra/etapa/responsável/custo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const it = await item(transaction);
    const wh = await warehouse(transaction);
    const { project, stage, site } = await projectWithSite(transaction);
    await receive(transaction, it.id, wh.id, 10, 12);
    await assert.rejects(
      () => requisitionsService.createRequisition(withTenant({ warehouseLocationId: wh.id, projectLocationId: site.id, projectId: project.id, items: [{ inventoryItemId: it.id, quantity: 1 }] }), tenant.userId, transaction),
      expectCode('INVENTORY_REQUISITION_STAGE_REQUIRED')
    );
    const requisition = await requisitionsService.createRequisition(
      withTenant({ warehouseLocationId: wh.id, projectLocationId: site.id, projectId: project.id, stageId: stage.id, items: [{ inventoryItemId: it.id, quantity: 2 }] }),
      tenant.userId,
      transaction
    );
    const reqApprover = await otherUser('req');
    await requisitionsService.decideRequisition(requisition.id, 'APPROVED', reqApprover.userId, tenant.groupId, tenant.companyId, transaction);
    await assert.rejects(
      () => requisitionsService.issueRequisition(requisition.id, admin(), tenant.groupId, tenant.companyId, transaction, {}),
      expectCode('INVENTORY_REQUISITION_RESPONSIBLE_REQUIRED')
    );
    const resp = await person(transaction);
    await requisitionsService.issueRequisition(requisition.id, admin(), tenant.groupId, tenant.companyId, transaction, { responsiblePersonId: resp.id });
    const out = await InventoryMovement.findOne({ where: { sourceId: requisition.id, movementType: 'OUT' }, transaction });
    assert.equal(out.projectId, project.id);
    assert.equal(out.stageId, stage.id);
    assert.equal(out.responsiblePersonId, resp.id);
    assert.equal(Number(out.unitCost), 12);
    assert.equal(Number(out.totalCost), 24);
  });
});

// =============================================================================================
// A8: contagem filtra por empresa em toda busca (defesa em profundidade além da RLS).
// =============================================================================================

test('A8: openCount/completeCount sempre filtram local, contagem aberta e saldo por groupId+companyId', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const it = await item(transaction);
    const wh = await warehouse(transaction);
    const seen = [];
    const spy = (Model, method) => {
      const original = Model[method];
      Model[method] = function spied(...args) {
        const opts = method === 'findByPk' ? { where: null } : args[0] || {};
        seen.push({ model: Model.name, method, where: opts.where });
        return original.apply(this, args);
      };
      return () => {
        Model[method] = original;
      };
    };
    const restores = [
      spy(InventoryLocation, 'findByPk'),
      spy(InventoryLocation, 'findOne'),
      spy(InventoryCount, 'findOne'),
      spy(InventoryStockBalance, 'findOne'),
    ];
    try {
      const count = await countsService.openCount(withTenant({ locationId: wh.id }), tenant.userId, transaction);
      await countsService.addCountItem(count.id, tenant.groupId, tenant.companyId, { inventoryItemId: it.id, countedQuantity: 1 }, transaction);
      await countsService.completeCount(count.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
    } finally {
      restores.forEach((r) => r());
    }
    const unscoped = seen.filter((s) => !s.where || s.where.companyId !== tenant.companyId || s.where.groupId !== tenant.groupId);
    assert.deepEqual(unscoped.map((s) => `${s.model}.${s.method}`), [], 'toda busca da contagem precisa filtrar por groupId e companyId');
  });
});

// =============================================================================================
// A10: custo médio com saldo zerado ou negativo.
// =============================================================================================

test('A10: entrada sobre saldo negativo usa o custo da própria entrada (denominador nunca ≤ 0)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const it = await item(transaction);
    await InventoryItem.update({ allowNegativeStock: true }, { where: { id: it.id }, transaction });
    const wh = await warehouse(transaction);
    const resp = await person(transaction);
    await receive(transaction, it.id, wh.id, 5, 10);
    await movementsService.recordMovement(withTenant({ inventoryItemId: it.id, movementType: 'OUT', quantity: 10, sourceLocationId: wh.id, responsiblePersonId: resp.id, reason: 'Saída' }), admin(), transaction);
    // saldo -5, custo médio 10. Entrada de 5 a 20: denominador -5 + 5 = 0 na fórmula antiga.
    await receive(transaction, it.id, wh.id, 5, 20);
    let refreshed = await InventoryItem.findByPk(it.id, { transaction });
    assert.ok(Number.isFinite(Number(refreshed.averageCost)), `custo médio finito, recebido ${refreshed.averageCost}`);
    assert.equal(Number(refreshed.averageCost), 20);

    await movementsService.recordMovement(withTenant({ inventoryItemId: it.id, movementType: 'OUT', quantity: 3, sourceLocationId: wh.id, responsiblePersonId: resp.id, reason: 'Saída' }), admin(), transaction);
    // saldo -3. Entrada de 6 a 40: fórmula antiga (-3×20 + 6×40)/3 = 60 (acima de qualquer custo real).
    await receive(transaction, it.id, wh.id, 6, 40);
    refreshed = await InventoryItem.findByPk(it.id, { transaction });
    assert.equal(Number(refreshed.averageCost), 40);
  });
});

// =============================================================================================
// A11: patrimônio baixado/perdido não aceita edição.
// =============================================================================================

test('A11: updateAsset em patrimônio DISPOSED ou LOST é recusado (409)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    for (const status of ['DISPOSED', 'LOST']) {
      const asset = await assetsService.createAsset(withTenant({ name: `HOMO QA rev19 ${status} ${uniqueSuffix()}`, assetTag: `REV19A11-${uniqueSuffix()}` }), tenant.userId, transaction);
      await sequelize.query('UPDATE inventory.assets SET status = :status WHERE id = :id', { replacements: { status, id: asset.id }, transaction });
      await assert.rejects(
        () => assetsService.updateAsset(asset.id, tenant.groupId, tenant.companyId, { acquisitionValue: 1 }, tenant.userId, transaction),
        (err) => expectCode('ASSET_NOT_IN_CIRCULATION')(err) && err.statusCode === 409
      );
    }
  });
});
