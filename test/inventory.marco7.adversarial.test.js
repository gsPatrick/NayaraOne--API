'use strict';

// Auditoria de conformidade contratual Marco 7 (2026-10-07) — EST-TS-07, EST-TS-09, EST-TS-10.
//
// Os guards destes cenários já existiam no código (movements/counts/lossCases.service.js), mas
// sem teste automatizado dedicado. Todos os testes rodam em `withRollbackTenantTransaction`
// (nada persiste no banco de dev compartilhado).
//
// ATENÇÃO — ACHADOS REAIS: os testes marcados "[ACHADO]" abaixo FALHAM de propósito contra o
// código atual. Eles provam variações do mesmo cenário contratual que o guard existente NÃO
// cobre (motivo só com espaços; evidência nula/inexistente). Não foram "pulados" para não
// esconder o achado — a correção pertence aos services (fora do escopo deste arquivo de testes).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const movementsService = require('../src/features/inventory/movements.service');
const countsService = require('../src/features/inventory/counts.service');
const lossCasesService = require('../src/features/inventory/lossCases.service');
const filesService = require('../src/features/files/files.service');
const { InventoryMovement, InventoryLossCase } = require('../src/models');
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

const approver = () => ({ userId: tenant.userId, canApprove: true });
const operator = () => ({ userId: tenant.userId, canApprove: false });

async function createItemAndLocation(transaction, initialQty = 0) {
  const suffix = uniqueSuffix();
  const item = await itemsService.createItem(
    withTenant({ name: `HOMO QA M7 ADV ${suffix}`, sku: `M7ADV-${suffix}`, unitOfMeasure: 'UN' }),
    tenant.userId,
    transaction
  );
  const location = await itemsService.createLocation(
    withTenant({ name: `HOMO QA M7 ADV Deposito ${suffix}`, locationType: 'WAREHOUSE' }),
    tenant.userId,
    transaction
  );
  if (initialQty > 0) {
    await movementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: initialQty, destinationLocationId: location.id }),
      operator(),
      transaction
    );
  }
  return { item, location };
}

async function readBalanceRow(itemId, locationId, transaction) {
  const [[row]] = await sequelize.query(
    'SELECT quantity_on_hand, updated_at FROM inventory.stock_balances WHERE inventory_item_id = :itemId AND location_id = :locationId',
    { replacements: { itemId, locationId }, transaction }
  );
  return row ? { qty: Number(row.quantity_on_hand), updatedAt: new Date(row.updated_at).toISOString() } : null;
}

function expectCode(code) {
  return (err) => {
    assert.ok(err instanceof AppError, `esperado AppError(${code}), recebido: ${err?.name} ${err?.message}`);
    assert.equal(err.code, code);
    return true;
  };
}

// ---------------------------------------------------------------------------------------------
// EST-TS-07: "Ajuste sem motivo → bloqueado."
// ---------------------------------------------------------------------------------------------

for (const movementType of ['ADJUSTMENT', 'LOSS', 'DISPOSAL']) {
  for (const [label, reason] of [['ausente', undefined], ['null', null], ['string vazia', '']]) {
    test(`EST-TS-07: ${movementType} com motivo ${label} é bloqueado com INVENTORY_MOVEMENT_REASON_REQUIRED (mesmo com inventory:approve)`, async () => {
      await withRollbackTenantTransaction(tenant, async (transaction) => {
        const { item, location } = await createItemAndLocation(transaction, 10);
        const payload =
          movementType === 'ADJUSTMENT'
            ? { inventoryItemId: item.id, movementType, quantity: 2, destinationLocationId: location.id }
            : { inventoryItemId: item.id, movementType, quantity: 2, sourceLocationId: location.id };
        if (reason !== undefined) payload.reason = reason;

        await assert.rejects(() => movementsService.recordMovement(withTenant(payload), approver(), transaction), expectCode('INVENTORY_MOVEMENT_REASON_REQUIRED'));

        const count = await InventoryMovement.count({ where: { inventoryItemId: item.id, movementType }, transaction });
        assert.equal(count, 0, 'nenhum movimento pode ter sido gravado');
        assert.equal(await movementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction), 10, 'saldo intacto');
      });
    });
  }
}

test('EST-TS-07 (controle positivo): ADJUSTMENT com motivo e inventory:approve é aceito e altera o saldo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndLocation(transaction, 10);
    const movement = await movementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, movementType: 'ADJUSTMENT', quantity: 2, destinationLocationId: location.id, reason: 'Sobra encontrada na conferência' }),
      approver(),
      transaction
    );
    assert.equal(movement.reason, 'Sobra encontrada na conferência');
    assert.equal(await movementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction), 12);
  });
});

// [ACHADO] movements.service.js:121 usa `!reason` — uma string só com espaços é truthy e passa.
// "Ajuste sem motivo" na prática: o ledger imutável fica com reason = '   '.
test('EST-TS-07 [ACHADO — FALHA ESPERADA até correção no service]: ADJUSTMENT com motivo só de espaços ("   ") deve ser bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndLocation(transaction, 10);
    await assert.rejects(
      () =>
        movementsService.recordMovement(
          withTenant({ inventoryItemId: item.id, movementType: 'ADJUSTMENT', quantity: 2, destinationLocationId: location.id, reason: '   ' }),
          approver(),
          transaction
        ),
      expectCode('INVENTORY_MOVEMENT_REASON_REQUIRED')
    );
  });
});

// ---------------------------------------------------------------------------------------------
// EST-TS-09: "Contagem divergente → proposal, não altera saldo direto."
// ---------------------------------------------------------------------------------------------

test('EST-TS-09: completeCount com divergência NÃO altera stock_balances; só applyAdjustment (com inventory:approve) altera, via movimento ADJUSTMENT', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndLocation(transaction, 10);
    const movementsBefore = await InventoryMovement.count({ where: { inventoryItemId: item.id }, transaction });

    const count = await countsService.openCount(withTenant({ locationId: location.id }), tenant.userId, transaction);
    const line = await countsService.addCountItem(count.id, tenant.groupId, tenant.companyId, { inventoryItemId: item.id, countedQuantity: 7 }, transaction);

    const balanceBefore = await readBalanceRow(item.id, location.id, transaction);
    assert.equal(balanceBefore.qty, 10);

    const completed = await countsService.completeCount(count.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
    assert.equal(completed.status, 'COMPLETED');
    const completedLine = completed.items.find((l) => l.id === line.id);
    assert.equal(Number(completedLine.expectedQuantity), 10, 'expected travado no saldo do sistema');
    assert.equal(Number(completedLine.divergence), -3, 'divergência calculada = contado - esperado');
    assert.equal(completedLine.adjustmentMovementId, null, 'fechar a contagem não gera movimento de ajuste');

    const balanceAfterComplete = await readBalanceRow(item.id, location.id, transaction);
    assert.deepEqual(balanceAfterComplete, balanceBefore, 'completeCount NÃO pode escrever em stock_balances (nem quantidade, nem updated_at)');
    assert.equal(
      await InventoryMovement.count({ where: { inventoryItemId: item.id }, transaction }),
      movementsBefore,
      'completeCount NÃO pode gerar movimento'
    );

    // Sem alçada: proposta continua proposta.
    await assert.rejects(() => countsService.applyAdjustment(line.id, tenant.groupId, tenant.companyId, operator(), transaction), expectCode('INVENTORY_COUNT_APPROVAL_REQUIRED'));
    assert.deepEqual(await readBalanceRow(item.id, location.id, transaction), balanceBefore, 'applyAdjustment sem inventory:approve não altera o saldo');

    // Com alçada: ajuste efetivado via ledger.
    const adjusted = await countsService.applyAdjustment(line.id, tenant.groupId, tenant.companyId, approver(), transaction);
    assert.ok(adjusted.adjustmentMovementId, 'linha fica vinculada ao movimento de ajuste');
    assert.equal(await movementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction), 7, 'saldo só muda aqui, para o valor contado');

    const movement = await InventoryMovement.findByPk(adjusted.adjustmentMovementId, { transaction });
    assert.equal(movement.movementType, 'ADJUSTMENT');
    assert.equal(Number(movement.quantity), 3);
    assert.equal(movement.sourceLocationId, location.id, 'divergência negativa = ajuste de saída do local contado');
    assert.equal(movement.sourceType, 'COUNT');
    assert.equal(movement.sourceId, count.id);
    assert.ok(movement.reason && movement.reason.trim().length > 0, 'ajuste de contagem leva motivo');

    // Re-aplicar é idempotente (não debita de novo).
    await countsService.applyAdjustment(line.id, tenant.groupId, tenant.companyId, approver(), transaction);
    assert.equal(await movementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction), 7, 're-aplicar o mesmo ajuste não duplica');
    assert.equal(await InventoryMovement.count({ where: { inventoryItemId: item.id, movementType: 'ADJUSTMENT' }, transaction }), 1);
  });
});

// ---------------------------------------------------------------------------------------------
// EST-TS-10: "Loss sem evidência quando exigida → bloqueado."
// ---------------------------------------------------------------------------------------------

for (const [label, evidenceFileIds] of [['ausente', undefined], ['array vazio', []], ['null', null], ['string (não array)', 'abc']]) {
  test(`EST-TS-10: openLossCase com evidenceFileIds ${label} é bloqueado com LOSS_CASE_EVIDENCE_REQUIRED`, async () => {
    await withRollbackTenantTransaction(tenant, async (transaction) => {
      const { item, location } = await createItemAndLocation(transaction, 5);
      const payload = { inventoryItemId: item.id, locationId: location.id, quantity: 1, context: 'Quebra no transporte' };
      if (evidenceFileIds !== undefined) payload.evidenceFileIds = evidenceFileIds;

      await assert.rejects(() => lossCasesService.openLossCase(withTenant(payload), tenant.userId, transaction), expectCode('LOSS_CASE_EVIDENCE_REQUIRED'));
      assert.equal(await InventoryLossCase.count({ where: { inventoryItemId: item.id }, transaction }), 0, 'nenhum loss_case gravado');
      assert.equal(await movementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction), 5, 'saldo intacto');
    });
  });
}

test('EST-TS-10 (controle positivo): openLossCase com evidência real (arquivo enviado) é aceito', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndLocation(transaction, 5);
    const file = await filesService.uploadFile(
      withTenant({ fileName: 'evidencia-m7.jpg', mimeType: 'image/jpeg', contentBase64: Buffer.from('EVIDENCIA-M7').toString('base64'), category: 'generic' }),
      tenant.userId,
      transaction
    );
    const lossCase = await lossCasesService.openLossCase(
      withTenant({ inventoryItemId: item.id, locationId: location.id, quantity: 1, context: 'Quebra no transporte', evidenceFileIds: [file.id] }),
      tenant.userId,
      transaction
    );
    assert.equal(lossCase.status, 'OPEN');
    assert.equal(await movementsService.getBalance(item.id, location.id, tenant.groupId, tenant.companyId, transaction), 5, 'abrir o caso não baixa estoque (só a decisão aprovada)');
  });
});

// [ACHADO] lossCases.service.js:25 só checa `Array.isArray && length > 0` — `[null]` passa e o
// caso de perda é gravado com evidence_file_ids = {NULL}, i.e. sem nenhuma evidência real.
test('EST-TS-10 [ACHADO — FALHA ESPERADA até correção no service]: openLossCase com evidenceFileIds [null] deve ser bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndLocation(transaction, 5);
    await assert.rejects(
      () =>
        lossCasesService.openLossCase(
          withTenant({ inventoryItemId: item.id, locationId: location.id, quantity: 1, context: 'Sem evidência', evidenceFileIds: [null] }),
          tenant.userId,
          transaction
        ),
      expectCode('LOSS_CASE_EVIDENCE_REQUIRED')
    );
  });
});

// [ACHADO] o service não confere se os IDs de evidência existem em core.files (ou equivalente)
// — um UUID inventado é aceito como "evidência", o que esvazia EST-TS-10.
test('EST-TS-10 [ACHADO — FALHA ESPERADA até correção no service]: openLossCase com evidenceFileIds apontando para arquivo inexistente deve ser bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndLocation(transaction, 5);
    await assert.rejects(
      () =>
        lossCasesService.openLossCase(
          withTenant({ inventoryItemId: item.id, locationId: location.id, quantity: 1, context: 'Evidência inventada', evidenceFileIds: [randomUUID()] }),
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError, `esperado AppError de evidência inválida, recebido: ${err?.name} ${err?.message}`);
        assert.match(err.code, /^LOSS_CASE_/);
        return true;
      }
    );
  });
});
