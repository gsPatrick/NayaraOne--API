'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const assetsService = require('../src/features/inventory/assets.service');
const toolLoansService = require('../src/features/inventory/toolLoans.service');
const lossCasesService = require('../src/features/inventory/lossCases.service');
const filesService = require('../src/features/files/files.service');
const itemsService = require('../src/features/inventory/items.service');
const inventoryMovementsService = require('../src/features/inventory/movements.service');
const { upsertApprovalThreshold } = require('../src/features/construction/lossRecords.service');
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

// EST-006: loanTool exige destino da saída (destinationLocationId).
async function loanDestination(transaction) {
  const itemsService = require('../src/features/inventory/items.service');
  return itemsService.createLocation(withTenant({ name: `Destino empréstimo ${uniqueSuffix()}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);
}

// Bug real corrigido nesta auditoria (rodada 28, 2026-10-05): aprovar um loss_case de
// Asset/ferramenta (EST-010) nunca tocava o próprio Asset — o ativo declarado perdido/quebrado
// continuava AVAILABLE/LOANED, podia ser emprestado de novo, e mantinha o custodiante antigo.
test('inventory: aprovar loss_case de um Asset marca o patrimônio como LOST e limpa o custodiante', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const asset = await assetsService.createAsset(
      withTenant({ name: `Nível a laser ${suffix}`, assetTag: `LOSS-${suffix}` }),
      tenant.userId,
      transaction
    );
    const loan = await toolLoansService.loanTool(asset.id, { personUserId: tenant.userId, destinationLocationId: (await loanDestination(transaction)).id }, tenant.userId, tenant.groupId, tenant.companyId, transaction);

    const file = await filesService.uploadFile(
      withTenant({ fileName: 'evidencia.jpg', mimeType: 'image/jpeg', contentBase64: Buffer.from('EVIDENCIA').toString('base64'), category: 'generic' }),
      tenant.userId,
      transaction
    );

    const lossCase = await lossCasesService.openLossCase(
      withTenant({ assetId: asset.id, context: 'Ferramenta extraviada no canteiro.', evidenceFileIds: [file.id] }),
      tenant.userId,
      transaction
    );
    assert.equal(lossCase.status, 'OPEN');

    const decided = await lossCasesService.decideLossCase(lossCase.id, tenant.groupId, tenant.companyId, 'APPROVED', { userId: tenant.userId, canApprove: true }, transaction);
    assert.equal(decided.status, 'APPROVED');

    await asset.reload({ transaction });
    assert.equal(asset.status, 'LOST', 'ativo declarado perdido e aprovado precisa sair de circulação');
    assert.equal(asset.assignedToUserId, null, 'custodiante precisa ser limpo — a perda já foi formalizada');

    await assert.rejects(
      async () => toolLoansService.loanTool(asset.id, { personUserId: tenant.userId, destinationLocationId: (await loanDestination(transaction)).id }, tenant.userId, tenant.groupId, tenant.companyId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'TOOL_LOAN_ASSET_UNAVAILABLE');
        return true;
      }
    );
    // loan antigo não precisa de tratamento especial aqui — o teste só confirma que o asset
    // não pode ser reemprestado depois da perda aprovada.
    assert.ok(loan.id);
  });
});

test('inventory: REJECTAR um loss_case de Asset não altera o status do patrimônio', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const asset = await assetsService.createAsset(
      withTenant({ name: `Trena a laser ${suffix}`, assetTag: `LOSS2-${suffix}` }),
      tenant.userId,
      transaction
    );
    const file = await filesService.uploadFile(
      withTenant({ fileName: 'evidencia2.jpg', mimeType: 'image/jpeg', contentBase64: Buffer.from('EVIDENCIA2').toString('base64'), category: 'generic' }),
      tenant.userId,
      transaction
    );
    const lossCase = await lossCasesService.openLossCase(
      withTenant({ assetId: asset.id, context: 'Relato de perda não confirmado.', evidenceFileIds: [file.id] }),
      tenant.userId,
      transaction
    );

    await lossCasesService.decideLossCase(lossCase.id, tenant.groupId, tenant.companyId, 'REJECTED', { userId: tenant.userId, canApprove: true }, transaction);

    await asset.reload({ transaction });
    assert.equal(asset.status, 'AVAILABLE', 'rejeitar o caso não pode alterar o asset');
  });
});

// Bug real corrigido nesta auditoria (rodada 30, 2026-10-05): aprovar a perda de um Asset que
// ainda tinha um InventoryToolLoan OPEN deixava esse empréstimo "esquecido" — um returnTool
// posterior sobre ele reescrevia asset.status de volta pra AVAILABLE/MAINTENANCE, revertendo a
// perda formalizada sem controle nenhum. Mesma classe de bug da R29, aqui no caminho returnTool.
test('inventory: aprovar a perda de um Asset ainda emprestado fecha o loan e bloqueia returnTool depois', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const asset = await assetsService.createAsset(
      withTenant({ name: `Compactador ${suffix}`, assetTag: `LOSTLOAN-${suffix}` }),
      tenant.userId,
      transaction
    );
    const loan = await toolLoansService.loanTool(asset.id, { personUserId: tenant.userId, destinationLocationId: (await loanDestination(transaction)).id }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    assert.equal(loan.status, 'OPEN');

    const file = await filesService.uploadFile(
      withTenant({ fileName: 'evidencia3.jpg', mimeType: 'image/jpeg', contentBase64: Buffer.from('EVIDENCIA3').toString('base64'), category: 'generic' }),
      tenant.userId,
      transaction
    );
    const lossCase = await lossCasesService.openLossCase(
      withTenant({ assetId: asset.id, context: 'Perda confirmada enquanto emprestada.', evidenceFileIds: [file.id] }),
      tenant.userId,
      transaction
    );
    await lossCasesService.decideLossCase(lossCase.id, tenant.groupId, tenant.companyId, 'APPROVED', { userId: tenant.userId, canApprove: true }, transaction);

    await loan.reload({ transaction });
    assert.equal(loan.status, 'LOST', 'empréstimo aberto precisa ser fechado (não fica "esquecido" OPEN) quando a perda do asset é aprovada');

    await assert.rejects(
      () => toolLoansService.returnTool(loan.id, { conditionCode: 'OK' }, tenant.userId, tenant.groupId, tenant.companyId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'TOOL_LOAN_INVALID_TRANSITION');
        return true;
      }
    );

    await asset.reload({ transaction });
    assert.equal(asset.status, 'LOST', 'a perda aprovada não pode ser revertida por nenhum caminho');
  });
});

// GAP 3 (fechamento de auditoria externa Nayara, Marco 6): alçada por VALOR para perda de
// item de Estoque — mesmo padrão já aprovado/testado em
// construction/lossRecords.service.js#createLossRecord. Acima da alçada configurada
// (construction.approval_thresholds, context INVENTORY_LOSS), o caso nasce PENDING_APPROVAL
// (não gera movimento nenhum até decisão humana explícita via inventory:approve).
test('inventory: loss_case de item ACIMA da alçada por valor nasce PENDING_APPROVAL (sem movimento até decisão explícita)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    await upsertApprovalThreshold(
      { groupId: tenant.groupId, companyId: tenant.companyId, context: 'INVENTORY_LOSS', maxAutoApproveAmount: 500 },
      tenant.userId,
      transaction
    );

    const location = await itemsService.createLocation(withTenant({ name: `Local alçada ${suffix}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);
    const item = await itemsService.createItem(
      withTenant({ name: `Cabo de cobre ${suffix}`, sku: `ALCADA-${suffix}`, unitOfMeasure: 'UN', itemType: 'CONSUMABLE', averageCost: 100, allowNegativeStock: true }),
      tenant.userId,
      transaction
    );
    await inventoryMovementsService.recordMovement(
      { groupId: tenant.groupId, companyId: tenant.companyId, inventoryItemId: item.id, movementType: 'IN', quantity: 50, destinationLocationId: location.id },
      { userId: tenant.userId, canApprove: true },
      transaction
    );

    const file = await filesService.uploadFile(
      withTenant({ fileName: 'evidencia-alcada-alta.jpg', mimeType: 'image/jpeg', contentBase64: Buffer.from('EVIDENCIA_ALCADA_ALTA').toString('base64'), category: 'generic' }),
      tenant.userId,
      transaction
    );

    const lossCase = await lossCasesService.openLossCase(
      withTenant({
        inventoryItemId: item.id,
        locationId: location.id,
        quantity: 10,
        context: 'Extravio de bobina de cabo — valor alto.',
        evidenceFileIds: [file.id],
        estimatedCost: 1000, // acima da alçada de 500
      }),
      tenant.userId,
      transaction
    );
    assert.equal(lossCase.status, 'PENDING_APPROVAL', 'perda acima da alçada não pode autoaprovar');
    assert.equal(lossCase.resultingMovementId, null, 'sem decisão explícita, nenhum movimento pode ter sido gerado');

    const balanceBeforeDecision = await inventoryMovementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(balanceBeforeDecision, 50, 'saldo não pode cair antes da decisão humana explícita');

    const decided = await lossCasesService.decideLossCase(
      lossCase.id,
      tenant.groupId,
      tenant.companyId,
      'APPROVED',
      { userId: tenant.userId, canApprove: true },
      transaction
    );
    assert.equal(decided.status, 'APPROVED');
    assert.ok(decided.resultingMovementId, 'decisão explícita precisa gerar o movimento LOSS');

    const balanceAfterDecision = await inventoryMovementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(balanceAfterDecision, 40, 'só depois da decisão explícita o saldo cai');
  });
});

// Perda ABAIXO da alçada: autoaprova na abertura (mesmo caminho/efeitos de decideLossCase),
// sem exigir nenhuma chamada separada com inventory:approve.
test('inventory: loss_case de item ABAIXO da alçada por valor autoaprova na abertura (gera movimento LOSS imediatamente)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    await upsertApprovalThreshold(
      { groupId: tenant.groupId, companyId: tenant.companyId, context: 'INVENTORY_LOSS', maxAutoApproveAmount: 500 },
      tenant.userId,
      transaction
    );

    const location = await itemsService.createLocation(withTenant({ name: `Local alçada baixa ${suffix}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);
    const item = await itemsService.createItem(
      withTenant({ name: `Parafuso ${suffix}`, sku: `ALCADA-BAIXA-${suffix}`, unitOfMeasure: 'UN', itemType: 'CONSUMABLE', averageCost: 2, allowNegativeStock: true }),
      tenant.userId,
      transaction
    );
    await inventoryMovementsService.recordMovement(
      { groupId: tenant.groupId, companyId: tenant.companyId, inventoryItemId: item.id, movementType: 'IN', quantity: 100, destinationLocationId: location.id },
      { userId: tenant.userId, canApprove: true },
      transaction
    );

    const file = await filesService.uploadFile(
      withTenant({ fileName: 'evidencia-alcada-baixa.jpg', mimeType: 'image/jpeg', contentBase64: Buffer.from('EVIDENCIA_ALCADA_BAIXA').toString('base64'), category: 'generic' }),
      tenant.userId,
      transaction
    );

    const lossCase = await lossCasesService.openLossCase(
      withTenant({
        inventoryItemId: item.id,
        locationId: location.id,
        quantity: 10,
        context: 'Pequeno extravio de parafusos — valor baixo.',
        evidenceFileIds: [file.id],
        estimatedCost: 20, // abaixo da alçada de 500 (ninguém com inventory:approve precisou agir)
      }),
      tenant.userId,
      transaction
    );
    assert.equal(lossCase.status, 'APPROVED', 'perda abaixo da alçada precisa autoaprovar na própria abertura');
    assert.ok(lossCase.resultingMovementId, 'autoaprovação precisa gerar o movimento LOSS imediatamente');

    const balance = await inventoryMovementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(balance, 90, 'saldo já cai na abertura, sem esperar decisão separada');
  });
});
