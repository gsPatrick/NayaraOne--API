'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const assetsService = require('../src/features/inventory/assets.service');
const toolLoansService = require('../src/features/inventory/toolLoans.service');
const lossCasesService = require('../src/features/inventory/lossCases.service');
const filesService = require('../src/features/files/files.service');
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
