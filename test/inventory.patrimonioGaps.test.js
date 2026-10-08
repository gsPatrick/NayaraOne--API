'use strict';

// GAPS REAIS CORRIGIDOS (auditoria Marco 7, 2026-10-08) — regras de negócio de patrimônio que
// faltavam, no mesmo padrão de guarda já usado por assets.service.js#disposeAsset:
//   Item 7  — transferAsset bloqueia ferramenta LOANED (com InventoryToolLoan OPEN/OVERDUE).
//   Item 8  — decideLossCase (asset aprovado) gera um AssetMovement real documentando a perda.
//   Item 9  — openLossCase bloqueia asset com InventoryMaintenanceOrder OPEN.
//   Item 10 — toolLoans.service.js#loanTool bloqueia asset com InventoryLossCase OPEN.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { AssetMovement } = require('../src/models');
const assetsService = require('../src/features/inventory/assets.service');
const toolLoansService = require('../src/features/inventory/toolLoans.service');
const maintenanceService = require('../src/features/inventory/maintenance.service');
const lossCasesService = require('../src/features/inventory/lossCases.service');
const itemsService = require('../src/features/inventory/items.service');
const filesService = require('../src/features/files/files.service');
const AppError = require('../src/utils/AppError');

let tenant;
let approver;

before(async () => {
  tenant = await getSeedTenant();
  approver = { userId: tenant.userId, canApprove: true };
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

async function createAsset(transaction, extra = {}) {
  const suffix = uniqueSuffix();
  return assetsService.createAsset(withTenant({ name: `Patrimônio Gaps ${suffix}`, assetTag: `PATGAP-${suffix}`, ...extra }), tenant.userId, transaction);
}

async function createEvidence(transaction) {
  return filesService.uploadFile(
    withTenant({ fileName: 'evidencia-gaps.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('EVIDENCIA GAPS').toString('base64'), category: 'generic' }),
    tenant.userId,
    transaction
  );
}

async function loanDestination(transaction) {
  return itemsService.createLocation(withTenant({ name: `Destino Gaps ${uniqueSuffix()}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);
}

// Item 7 ---------------------------------------------------------------------------------------

test('Item 7: transferAsset recusa transferir uma ferramenta emprestada (LOANED)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);
    const destination = await loanDestination(transaction);
    await toolLoansService.loanTool(
      asset.id,
      { personUserId: tenant.userId, destinationLocationId: destination.id },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );
    await asset.reload({ transaction });
    assert.equal(asset.status, 'LOANED');

    const otherLocation = await loanDestination(transaction);
    await assert.rejects(
      () => assetsService.transferAsset(asset.id, tenant.groupId, tenant.companyId, { destinationLocationId: otherLocation.id }, tenant.userId, transaction),
      expectCode('ASSET_TRANSFER_ASSET_LOANED')
    );
  });
});

// Item 8 ---------------------------------------------------------------------------------------

test('Item 8: aprovar um caso de perda de Asset gera um AssetMovement real documentando a perda', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);
    const evidence = await createEvidence(transaction);
    const lossCase = await lossCasesService.openLossCase(
      withTenant({ assetId: asset.id, context: 'Perda formalizada (item 8).', evidenceFileIds: [evidence.id] }),
      tenant.userId,
      transaction
    );

    const beforeCount = await AssetMovement.count({ where: { assetId: asset.id }, transaction });
    assert.equal(beforeCount, 0, 'nenhum movimento antes da decisão');

    await lossCasesService.decideLossCase(lossCase.id, tenant.groupId, tenant.companyId, 'APPROVED', approver, transaction);

    await asset.reload({ transaction });
    assert.equal(asset.status, 'LOST');

    const movements = await assetsService.listAssetMovements(asset.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(movements.length, 1, 'a perda aprovada precisa gerar exatamente um AssetMovement');
    assert.equal(movements[0].destinationLocationId, null, 'perda não tem destino — saiu de circulação');
  });
});

// Item 9 ---------------------------------------------------------------------------------------

test('Item 9: openLossCase recusa abrir caso de perda sobre asset com OS de manutenção OPEN', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);
    await maintenanceService.openMaintenanceOrder(withTenant({ assetId: asset.id, description: 'Revisão em andamento.' }), tenant.userId, transaction);

    const evidence = await createEvidence(transaction);
    await assert.rejects(
      () =>
        lossCasesService.openLossCase(
          withTenant({ assetId: asset.id, context: 'Tentativa de perda com OS aberta.', evidenceFileIds: [evidence.id] }),
          tenant.userId,
          transaction
        ),
      expectCode('LOSS_CASE_MAINTENANCE_OPEN')
    );
  });
});

// Item 10 --------------------------------------------------------------------------------------

test('Item 10: loanTool recusa emprestar asset com caso de perda OPEN', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);
    const evidence = await createEvidence(transaction);
    await lossCasesService.openLossCase(
      withTenant({ assetId: asset.id, context: 'Apuração em andamento (item 10).', evidenceFileIds: [evidence.id] }),
      tenant.userId,
      transaction
    );

    const destination = await loanDestination(transaction);
    await assert.rejects(
      () =>
        toolLoansService.loanTool(
          asset.id,
          { personUserId: tenant.userId, destinationLocationId: destination.id },
          tenant.userId,
          tenant.groupId,
          tenant.companyId,
          transaction
        ),
      expectCode('TOOL_LOAN_LOSS_CASE_OPEN')
    );
  });
});
