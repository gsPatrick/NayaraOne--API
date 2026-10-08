'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const assetsService = require('../src/features/inventory/assets.service');
const toolLoansService = require('../src/features/inventory/toolLoans.service');
const maintenanceService = require('../src/features/inventory/maintenance.service');
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

// Bug real corrigido nesta auditoria (rodada 14, 2026-10-05): abrir uma OS de manutenção direto
// via openMaintenanceOrder (endpoint POST /inventory/maintenance-orders) nunca travava o asset
// — ele continuava AVAILABLE e podia ser emprestado normalmente com uma OS "OPEN" aberta sobre
// ele. O travamento só acontecia dentro do fluxo de devolução danificada (returnTool).
test('inventory: abrir OS de manutenção direto trava o asset em MAINTENANCE (não fica disponível pra empréstimo)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const asset = await assetsService.createAsset(
      withTenant({ name: `Compressor ${suffix}`, assetTag: `MNT-${suffix}` }),
      tenant.userId,
      transaction
    );
    assert.equal(asset.status, 'AVAILABLE');

    const order = await maintenanceService.openMaintenanceOrder(
      withTenant({ assetId: asset.id, description: 'Defeito reportado manualmente.' }),
      tenant.userId,
      transaction
    );
    assert.equal(order.status, 'OPEN');

    await asset.reload({ transaction });
    assert.equal(asset.status, 'MAINTENANCE', 'abrir a OS precisa travar o asset — não pode ficar AVAILABLE com manutenção OPEN');

    await assert.rejects(
      async () => toolLoansService.loanTool(asset.id, { personUserId: tenant.userId, destinationLocationId: (await loanDestination(transaction)).id }, tenant.userId, tenant.groupId, tenant.companyId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'TOOL_LOAN_ASSET_UNAVAILABLE');
        return true;
      }
    );

    const closed = await maintenanceService.closeMaintenanceOrder(order.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
    assert.equal(closed.status, 'CLOSED');
    await asset.reload({ transaction });
    assert.equal(asset.status, 'AVAILABLE', 'fechar a OS precisa liberar o asset de volta');
  });
});

test('inventory: não é possível abrir OS de manutenção sobre um asset emprestado (LOANED)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const asset = await assetsService.createAsset(
      withTenant({ name: `Furadeira ${suffix}`, assetTag: `MNT2-${suffix}` }),
      tenant.userId,
      transaction
    );
    await toolLoansService.loanTool(asset.id, { personUserId: tenant.userId, destinationLocationId: (await loanDestination(transaction)).id }, tenant.userId, tenant.groupId, tenant.companyId, transaction);

    await assert.rejects(
      () => maintenanceService.openMaintenanceOrder(withTenant({ assetId: asset.id, description: 'x' }), tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'MAINTENANCE_ASSET_LOANED');
        return true;
      }
    );
  });
});

test('inventory: returnTool com devolução danificada continua abrindo manutenção e travando o asset (fluxo original, sem regressão)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const asset = await assetsService.createAsset(
      withTenant({ name: `Serra ${suffix}`, assetTag: `MNT3-${suffix}` }),
      tenant.userId,
      transaction
    );
    const loan = await toolLoansService.loanTool(asset.id, { personUserId: tenant.userId, destinationLocationId: (await loanDestination(transaction)).id }, tenant.userId, tenant.groupId, tenant.companyId, transaction);

    const { maintenanceOrder } = await toolLoansService.returnTool(loan.id, { conditionCode: 'DAMAGED' }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    assert.ok(maintenanceOrder);
    assert.equal(maintenanceOrder.status, 'OPEN');

    await asset.reload({ transaction });
    assert.equal(asset.status, 'MAINTENANCE');
  });
});

// Bug real corrigido nesta auditoria (rodada 21, 2026-10-05): returnTool nunca limpava
// assignedToUserId (custodiante, EST-014) — o custodiante ficava preso no último tomador mesmo
// depois da devolução, incluindo durante a manutenção subsequente.
test('inventory: devolver a ferramenta limpa o custodiante do asset (assignedToUserId)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const asset = await assetsService.createAsset(
      withTenant({ name: `Parafusadeira ${suffix}`, assetTag: `CUST-${suffix}` }),
      tenant.userId,
      transaction
    );
    const loan = await toolLoansService.loanTool(asset.id, { personUserId: tenant.userId, destinationLocationId: (await loanDestination(transaction)).id }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await asset.reload({ transaction });
    assert.equal(asset.assignedToUserId, tenant.userId);

    await toolLoansService.returnTool(loan.id, { conditionCode: 'OK' }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await asset.reload({ transaction });
    assert.equal(asset.status, 'AVAILABLE');
    assert.equal(asset.assignedToUserId, null, 'custodiante precisa ser limpo na devolução — não pode ficar presa no último tomador');
  });
});

test('inventory: devolução danificada também limpa o custodiante (mesmo indo pra MAINTENANCE)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const asset = await assetsService.createAsset(
      withTenant({ name: `Esmerilhadeira ${suffix}`, assetTag: `CUST2-${suffix}` }),
      tenant.userId,
      transaction
    );
    const loan = await toolLoansService.loanTool(asset.id, { personUserId: tenant.userId, destinationLocationId: (await loanDestination(transaction)).id }, tenant.userId, tenant.groupId, tenant.companyId, transaction);

    await toolLoansService.returnTool(loan.id, { conditionCode: 'DAMAGED' }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await asset.reload({ transaction });
    assert.equal(asset.status, 'MAINTENANCE');
    assert.equal(asset.assignedToUserId, null, 'custodiante precisa ser limpo mesmo quando a ferramenta volta danificada');
  });
});

// Bug real corrigido nesta auditoria (rodada 22, 2026-10-05): loanTool gravava o destino
// (EST-006) só no empréstimo, nunca propagava para asset.currentLocationId (EST-014); returnTool
// não restaurava a localização de origem. Mesma classe de bug da R21 (campo de transição que
// não era mantido), aqui aplicada à localização em vez do custodiante.
test('inventory: emprestar a ferramenta move currentLocationId pro destino, e devolver restaura a origem', async () => {
  const itemsService = require('../src/features/inventory/items.service');
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const origin = await itemsService.createLocation(withTenant({ name: `Almoxarifado ${suffix}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);
    const destination = await itemsService.createLocation(withTenant({ name: `Canteiro ${suffix}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);

    const asset = await assetsService.createAsset(
      withTenant({ name: `Betoneira ${suffix}`, assetTag: `LOC-${suffix}`, currentLocationId: origin.id }),
      tenant.userId,
      transaction
    );
    assert.equal(asset.currentLocationId, origin.id);

    const loan = await toolLoansService.loanTool(asset.id, { personUserId: tenant.userId, destinationLocationId: destination.id }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await asset.reload({ transaction });
    assert.equal(asset.currentLocationId, destination.id, 'empréstimo precisa mover o asset pro destino registrado (EST-006/EST-014)');

    await toolLoansService.returnTool(loan.id, { conditionCode: 'OK' }, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await asset.reload({ transaction });
    assert.equal(asset.currentLocationId, origin.id, 'devolução precisa restaurar a localização de origem');
  });
});

// Bug real corrigido nesta auditoria (rodada 23, 2026-10-05): nada impedia abrir uma SEGUNDA OS
// OPEN pro mesmo asset — fechar uma das duas liberava o asset incondicionalmente, deixando a
// outra OS "esquecida" aberta enquanto o patrimônio já circulava como AVAILABLE de novo.
test('inventory: não é possível abrir uma segunda OS de manutenção enquanto a primeira ainda está OPEN', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const asset = await assetsService.createAsset(
      withTenant({ name: `Guincho ${suffix}`, assetTag: `DUP-${suffix}` }),
      tenant.userId,
      transaction
    );
    await maintenanceService.openMaintenanceOrder(withTenant({ assetId: asset.id, description: 'Primeira falha.' }), tenant.userId, transaction);

    await assert.rejects(
      () => maintenanceService.openMaintenanceOrder(withTenant({ assetId: asset.id, description: 'Segunda falha.' }), tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'MAINTENANCE_ORDER_ALREADY_OPEN');
        return true;
      }
    );
  });
});

test('inventory: fechar uma OS não libera o asset se restar outra OS OPEN pro mesmo asset', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const asset = await assetsService.createAsset(
      withTenant({ name: `Andaime ${suffix}`, assetTag: `DUP2-${suffix}` }),
      tenant.userId,
      transaction
    );
    const order1 = await maintenanceService.openMaintenanceOrder(withTenant({ assetId: asset.id, description: 'Falha A.' }), tenant.userId, transaction);

    // Simula uma 2ª OS já existente no banco (ex.: criada antes da correção, ou por um caminho
    // de dados legado) pra garantir que closeMaintenanceOrder respeita a invariante mesmo com
    // duas OPEN simultâneas já persistidas.
    const { InventoryMaintenanceOrder } = require('../src/models');
    const order2 = await InventoryMaintenanceOrder.create(
      withTenant({ assetId: asset.id, description: 'Falha B.', status: 'OPEN', openedAt: new Date() }),
      { transaction }
    );

    await maintenanceService.closeMaintenanceOrder(order1.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
    await asset.reload({ transaction });
    assert.equal(asset.status, 'MAINTENANCE', 'ainda há outra OS OPEN — o asset não pode voltar a ficar disponível');

    await maintenanceService.closeMaintenanceOrder(order2.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
    await asset.reload({ transaction });
    assert.equal(asset.status, 'AVAILABLE', 'fechada a última OS OPEN, o asset finalmente libera');
  });
});

// Bug real corrigido nesta auditoria (rodada 29, 2026-10-05): a guarda de openMaintenanceOrder
// era uma blacklist (só bloqueava LOANED) — um asset LOST (perda formalmente aprovada, R28)
// passava direto e tinha o status sobrescrito pra MAINTENANCE sem nenhum controle, reabrindo-o
// pra circulação como se a perda nunca tivesse existido.
test('inventory: não é possível abrir OS de manutenção sobre um asset declarado LOST (perda aprovada)', async () => {
  const lossCasesService = require('../src/features/inventory/lossCases.service');
  const filesService = require('../src/features/files/files.service');
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const asset = await assetsService.createAsset(
      withTenant({ name: `Nível a laser ${suffix}`, assetTag: `LOST-${suffix}` }),
      tenant.userId,
      transaction
    );
    const file = await filesService.uploadFile(
      withTenant({ fileName: 'evidencia.jpg', mimeType: 'image/jpeg', contentBase64: Buffer.from('EVIDENCIA').toString('base64'), category: 'generic' }),
      tenant.userId,
      transaction
    );
    const lossCase = await lossCasesService.openLossCase(
      withTenant({ assetId: asset.id, context: 'Perda confirmada.', evidenceFileIds: [file.id] }),
      tenant.userId,
      transaction
    );
    await lossCasesService.decideLossCase(lossCase.id, tenant.groupId, tenant.companyId, 'APPROVED', { userId: tenant.userId, canApprove: true }, transaction);
    await asset.reload({ transaction });
    assert.equal(asset.status, 'LOST');

    await assert.rejects(
      () => maintenanceService.openMaintenanceOrder(withTenant({ assetId: asset.id, description: 'Tentativa de reabrir.' }), tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'MAINTENANCE_ASSET_LOST');
        return true;
      }
    );
  });
});

// Bug real corrigido nesta auditoria (rodada 50, 2026-10-05): o contrato lista explicitamente
// "Asset possui aquisição, valor, localização, custodiante, garantia, status e manutenção" —
// mas não existia nenhuma forma de editar acquiredAt/warrantyUntil depois da criação.
test('inventory: updateAsset permite registrar data de aquisição e garantia depois da criação', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const asset = await assetsService.createAsset(
      withTenant({ name: `Gerador ${suffix}`, assetTag: `UPD-${suffix}` }),
      tenant.userId,
      transaction
    );
    assert.equal(asset.warrantyUntil, null);

    const updated = await assetsService.updateAsset(
      asset.id,
      tenant.groupId,
      tenant.companyId,
      { acquiredAt: '2026-01-15', warrantyUntil: '2028-01-15', acquisitionValue: 5000 },
      tenant.userId,
      transaction
    );
    assert.equal(new Date(updated.warrantyUntil).toISOString().slice(0, 10), '2028-01-15');
    assert.equal(Number(updated.acquisitionValue), 5000);
  });
});

// Bug real corrigido nesta auditoria (rodada 52, 2026-10-05): toda transferência de patrimônio
// já gerava um AssetMovement, mas não existia nenhuma forma de ler esse histórico de volta.
test('inventory: listAssetMovements lê o histórico de transferências do patrimônio', async () => {
  const itemsService = require('../src/features/inventory/items.service');
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const originLocation = await itemsService.createLocation(withTenant({ name: `Origem ${suffix}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);
    const destLocation = await itemsService.createLocation(withTenant({ name: `Destino ${suffix}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);
    const asset = await assetsService.createAsset(
      withTenant({ name: `Compressor ${suffix}`, assetTag: `MOV-${suffix}`, currentLocationId: originLocation.id }),
      tenant.userId,
      transaction
    );

    await assetsService.transferAsset(asset.id, tenant.groupId, tenant.companyId, { destinationLocationId: destLocation.id }, tenant.userId, transaction);

    const movements = await assetsService.listAssetMovements(asset.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(movements.length, 1);
    assert.equal(movements[0].sourceLocationId, originLocation.id);
    assert.equal(movements[0].destinationLocationId, destLocation.id);
  });
});
