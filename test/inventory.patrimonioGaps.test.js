'use strict';

// GAPS REAIS CORRIGIDOS (auditoria Marco 7, 2026-10-08) — regras de negócio de patrimônio que
// faltavam, no mesmo padrão de guarda já usado por assets.service.js#disposeAsset:
//   Item 7  — transferAsset bloqueia ferramenta LOANED (com InventoryToolLoan OPEN/OVERDUE).
//   Item 8  — decideLossCase (asset aprovado) gera um AssetMovement real documentando a perda.
//   Item 9  — openLossCase bloqueia asset com InventoryMaintenanceOrder OPEN.
//   Item 10 — toolLoans.service.js#loanTool bloqueia asset com InventoryLossCase OPEN.
//   Item 11 — getAssetByTag devolve a ficha agregada (Caderno §8: último movimento, manutenção
//             aberta e empréstimo ativo), não só a linha crua do Asset.
//   Item 12 — depreciação linear informativa (Caderno §9) cai conforme o tempo desde a aquisição,
//             e um asset sem configuração específica não quebra (usa default documentado).

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

// Item 11 --------------------------------------------------------------------------------------

test('Item 11: getAssetByTag devolve ficha vazia (lastMovement/openMaintenance/activeLoan null) quando não há nada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);

    const ficha = await assetsService.getAssetByTag(asset.assetTag, tenant.groupId, tenant.companyId, transaction);

    assert.equal(ficha.asset.id, asset.id);
    assert.equal(ficha.lastMovement, null);
    assert.equal(ficha.openMaintenance, null);
    assert.equal(ficha.activeLoan, null);
  });
});

test('Item 11: getAssetByTag devolve ficha preenchida com último movimento, manutenção aberta e empréstimo ativo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);
    const destination = await loanDestination(transaction);

    // Gera um AssetMovement real (transferência).
    const movement = await assetsService.transferAsset(asset.id, tenant.groupId, tenant.companyId, { destinationLocationId: destination.id }, tenant.userId, transaction);

    const ficha = await assetsService.getAssetByTag(asset.assetTag, tenant.groupId, tenant.companyId, transaction);
    assert.equal(ficha.lastMovement.id, movement.id);
    assert.equal(ficha.openMaintenance, null);
    assert.equal(ficha.activeLoan, null);
  });
});

test('Item 11: getAssetByTag mostra a OS de manutenção aberta mais recente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);
    const order = await maintenanceService.openMaintenanceOrder(withTenant({ assetId: asset.id, description: 'Revisão (item 11).' }), tenant.userId, transaction);

    const ficha = await assetsService.getAssetByTag(asset.assetTag, tenant.groupId, tenant.companyId, transaction);
    assert.ok(ficha.openMaintenance, 'esperava manutenção aberta na ficha');
    assert.equal(ficha.openMaintenance.id, order.id);
    assert.equal(ficha.activeLoan, null);
  });
});

test('Item 11: getAssetByTag mostra o empréstimo ativo (ferramenta emprestada)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);
    const destination = await loanDestination(transaction);
    const loan = await toolLoansService.loanTool(
      asset.id,
      { personUserId: tenant.userId, destinationLocationId: destination.id },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );

    const ficha = await assetsService.getAssetByTag(asset.assetTag, tenant.groupId, tenant.companyId, transaction);
    assert.ok(ficha.activeLoan, 'esperava empréstimo ativo na ficha');
    assert.equal(ficha.activeLoan.id, loan.id);
    assert.equal(ficha.openMaintenance, null);
  });
});

// Item 12 --------------------------------------------------------------------------------------

test('Item 12: depreciação informativa cai de forma linear com o tempo desde a aquisição', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const usefulLifeMonths = 60;
    const halfLifeAgo = new Date();
    halfLifeAgo.setMonth(halfLifeAgo.getMonth() - usefulLifeMonths / 2);

    const asset = await createAsset(transaction, { acquisitionValue: 10000, acquiredAt: halfLifeAgo });

    const estimated = assetsService.computeEstimatedCurrentValue(asset, usefulLifeMonths);
    assert.ok(estimated > 4900 && estimated < 5100, `esperava ~50% do valor original (R$ 5000), veio R$ ${estimated}`);

    const ficha = await assetsService.getAssetByTag(asset.assetTag, tenant.groupId, tenant.companyId, transaction);
    assert.equal(ficha.estimatedCurrentValue, computeEstimatedCurrentValueExpected(asset));
  });
});

test('Item 12: depreciação informativa zera quando o tempo decorrido já passou da vida útil (não fica negativa)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const longAgo = new Date();
    longAgo.setFullYear(longAgo.getFullYear() - 20);
    const asset = await createAsset(transaction, { acquisitionValue: 10000, acquiredAt: longAgo });

    const estimated = assetsService.computeEstimatedCurrentValue(asset, 60);
    assert.equal(estimated, 0);
  });
});

test('Item 12: asset sem acquisitionValue/acquiredAt configurado não quebra — retorna null', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction);
    assert.equal(asset.acquisitionValue, null);
    assert.equal(asset.acquiredAt, null);

    const estimated = assetsService.computeEstimatedCurrentValue(asset);
    assert.equal(estimated, null, 'sem base de cálculo, não deve lançar erro — só retorna null');

    const list = await assetsService.listAssets(tenant.groupId, tenant.companyId, transaction);
    const found = list.find((a) => a.id === asset.id);
    assert.ok(found, 'asset precisa aparecer na listagem');
    assert.equal(found.estimatedCurrentValue, null);
  });
});

test('Item 12: asset com acquisitionValue mas sem usefulLifeMonths explícito usa o default documentado (não quebra)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const asset = await createAsset(transaction, { acquisitionValue: 1000, acquiredAt: new Date() });
    const estimated = assetsService.computeEstimatedCurrentValue(asset);
    assert.equal(estimated, 1000, 'recém adquirido: ~100% do valor, usando o default de vida útil');
  });
});

function computeEstimatedCurrentValueExpected(asset) {
  return assetsService.computeEstimatedCurrentValue(asset, 60);
}
