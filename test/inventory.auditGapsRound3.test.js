'use strict';

// GAP REAL CORRIGIDO (auditoria rodada 3, 2026-10-08):
//   decideLossCase setava lossCase.resultingMovementId = movement.id em memória, mas só
//   persistia esse campo no banco se o bloco condicional de responsiblePerson/chargeResponsible
//   rodasse .save() de novo. No caminho mais comum (aprovar sem cobrar responsável, sem trocar
//   responsiblePersonId), aquele save nunca executava e resultingMovementId ficava NULL no
//   banco para sempre, mesmo com o objeto em memória "parecendo certo" (o que escondia o bug em
//   testes que só verificavam o retorno em memória, nunca uma releitura do banco).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const movementsService = require('../src/features/inventory/movements.service');
const lossCasesService = require('../src/features/inventory/lossCases.service');
const assetsService = require('../src/features/inventory/assets.service');
const toolLoansService = require('../src/features/inventory/toolLoans.service');
const filesService = require('../src/features/files/files.service');
const { InventoryLossCase } = require('../src/models');
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

async function createLocation(transaction, locationType = 'WAREHOUSE', extra = {}) {
  return itemsService.createLocation(withTenant({ name: `GAP R3 Local ${uniqueSuffix()}`, locationType, ...extra }), tenant.userId, transaction);
}

async function createItem(transaction, extra = {}) {
  const suffix = uniqueSuffix();
  return itemsService.createItem(withTenant({ name: `GAP R3 Item ${suffix}`, sku: `GAPR3-${suffix}`, unitOfMeasure: 'UN', ...extra }), tenant.userId, transaction);
}

async function createEvidence(transaction) {
  return filesService.uploadFile(
    withTenant({ fileName: 'evidencia-perda-r3.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('EVIDENCIA R3').toString('base64'), category: 'generic' }),
    tenant.userId,
    transaction
  );
}

test('BUG 1 (resultingMovementId): aprovar SEM cobrar responsável e SEM trocar responsiblePersonId persiste resultingMovementId no banco', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const warehouse = await createLocation(transaction);
    const item = await createItem(transaction);
    const evidence = await createEvidence(transaction);

    await movementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 5, destinationLocationId: warehouse.id }),
      approver,
      transaction
    );

    const lossCase = await lossCasesService.openLossCase(
      withTenant({
        inventoryItemId: item.id,
        locationId: warehouse.id,
        quantity: 1,
        context: 'Quebra em transporte — sem cobrança',
        evidenceFileIds: [evidence.id],
      }),
      tenant.userId,
      transaction
    );

    // Caminho mais comum: decide SEM chargeResponsible e SEM responsiblePersonId — o bloco que
    // antigamente era o único a persistir resultingMovementId nunca roda aqui.
    const decided = await lossCasesService.decideLossCase(lossCase.id, tenant.groupId, tenant.companyId, 'APPROVED', approver, transaction, {});
    assert.ok(decided.resultingMovementId, 'resultingMovementId deveria estar presente no objeto retornado');

    // A verificação real do bug: releitura do banco (findByPk força SELECT, não usa cache em
    // memória do `decided`/`lossCase` atual).
    const reloaded = await InventoryLossCase.findByPk(lossCase.id, { transaction });
    assert.ok(reloaded.resultingMovementId, 'resultingMovementId precisa estar persistido no banco, não só em memória');
    assert.equal(reloaded.resultingMovementId, decided.resultingMovementId);
    assert.equal(reloaded.status, 'APPROVED');
  });
});

test('EST-TS-05: ferramenta já emprestada não pode sair de novo sem devolver antes', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const warehouse = await createLocation(transaction);
    const asset = await assetsService.createAsset(
      withTenant({ assetTag: `GAPR3-TOOL-${suffix}`, name: `Furadeira ${suffix}`, currentLocationId: warehouse.id }),
      tenant.userId,
      transaction
    );

    await toolLoansService.loanTool(
      asset.id,
      { personUserId: tenant.userId, destinationLocationId: warehouse.id },
      tenant.userId,
      tenant.groupId,
      tenant.companyId,
      transaction
    );

    await assert.rejects(
      () => toolLoansService.loanTool(
        asset.id,
        { personUserId: tenant.userId, destinationLocationId: warehouse.id },
        tenant.userId,
        tenant.groupId,
        tenant.companyId,
        transaction
      ),
      (err) => err instanceof AppError && err.code === 'TOOL_LOAN_ASSET_UNAVAILABLE'
    );
  });
});
