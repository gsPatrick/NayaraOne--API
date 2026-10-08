'use strict';

// Cobre os gaps encontrados na reauditoria RLS/multi-tenant + regras de negócio do Insurance Hub
// (2026-10-08). Cada teste aqui corresponde a um bug real corrigido no mesmo commit:
//   1. quotePolicy não validava policy.status antes de recotar (permitia sobrescrever prêmio de
//      apólice já ACTIVE/ISSUED).
//   3. premiumAmount nunca era validado como número finito > 0 em quotePolicy.
//   4. installmentsCount não checava inteiro nem tinha teto superior em issuePolicy.
//   6. openClaim não bloqueava sinistro duplicado (mesma descrição) ativo na mesma apólice.
//   8. movements.service.js#recordMovement aceitava qualquer evidenceFileId sem validar contra
//      a tabela File (nem companyId) para o REG-EST-002 de alto valor.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, createTestCostCenter } = require('./testHelpers');
const insuranceService = require('../src/features/procurement/insurance.service');
const movementsService = require('../src/features/inventory/movements.service');
const { InventoryItem, InventoryLocation, File } = require('../src/models');
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

function actor(extra = {}) {
  return { userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId, ...extra };
}

async function createItemAndWarehouse(transaction, averageCost = 100) {
  const suffix = Math.random().toString(36).slice(2, 10);
  const item = await InventoryItem.create(
    withTenant({
      sku: `AUD-${suffix}`,
      name: `Item auditoria ${suffix}`,
      unit: 'UN',
      itemType: 'MATERIAL',
      averageCost,
      allowNegativeStock: false,
    }),
    { transaction }
  );
  const location = await InventoryLocation.create(
    withTenant({ name: `Depósito auditoria ${suffix}`, locationType: 'WAREHOUSE' }),
    { transaction }
  );
  return { item, location };
}

async function receive(transaction, item, location, quantity) {
  return movementsService.recordMovement(
    withTenant({
      inventoryItemId: item.id,
      movementType: 'IN',
      quantity,
      destinationLocationId: location.id,
    }),
    actor({ canApprove: false }),
    transaction
  );
}

test('Item 1: quotePolicy recusa recotar apólice já ACTIVE/ISSUED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    await insuranceService.quotePolicy(policy.id, {}, actor(), transaction);
    const issued = await insuranceService.issuePolicy(
      policy.id,
      { effectiveDate: '2026-10-05', expiryDate: '2027-10-05' },
      actor(),
      transaction
    );
    assert.ok(['ACTIVE', 'ISSUED'].includes(issued.status));

    await assert.rejects(
      () => insuranceService.quotePolicy(policy.id, {}, actor(), transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INSURANCE_POLICY_INVALID_STATUS');
        return true;
      },
      'recotar uma apólice já emitida precisa ser bloqueado'
    );
  });
});

test('Item 3: quotePolicy recusa premiumAmount não-finito/<=0 vindo do adapter', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);

    // Sandbox: premiumAmount = estimatedValue * 0.01 quando estimatedValue é informado (ver
    // InsuranceAdapter.js) — um estimatedValue negativo produz um premiumAmount <= 0.
    await assert.rejects(
      () => insuranceService.quotePolicy(policy.id, { estimatedValue: -100 }, actor(), transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INSURANCE_POLICY_VALIDATION');
        return true;
      },
      'premiumAmount <= 0 precisa ser rejeitado'
    );

    // estimatedValue Infinity produz premiumAmount Infinity — precisa ser rejeitado também.
    await assert.rejects(
      () => insuranceService.quotePolicy(policy.id, { estimatedValue: Infinity }, actor(), transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INSURANCE_POLICY_VALIDATION');
        return true;
      },
      'premiumAmount Infinity precisa ser rejeitado'
    );

    // Confirma que o fluxo normal (sandbox devolve um premiumAmount válido) continua funcionando.
    const quoted = await insuranceService.quotePolicy(policy.id, {}, actor(), transaction);
    assert.ok(Number.isFinite(Number(quoted.premiumAmount)) && Number(quoted.premiumAmount) > 0);
  });
});

test('Item 4: issuePolicy recusa installmentsCount não-inteiro ou fora do teto de 60 parcelas', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    await insuranceService.quotePolicy(policy.id, {}, actor(), transaction);

    await assert.rejects(
      () => insuranceService.issuePolicy(
        policy.id,
        { effectiveDate: '2026-10-05', expiryDate: '2027-10-05', installmentsCount: 2.5 },
        actor(),
        transaction
      ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INSURANCE_POLICY_VALIDATION');
        return true;
      },
      'installmentsCount não-inteiro precisa ser rejeitado'
    );

    await assert.rejects(
      () => insuranceService.issuePolicy(
        policy.id,
        { effectiveDate: '2026-10-05', expiryDate: '2027-10-05', installmentsCount: 5000000 },
        actor(),
        transaction
      ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INSURANCE_POLICY_VALIDATION');
        return true;
      },
      'installmentsCount acima do teto precisa ser rejeitado'
    );

    // Apólice não pode ter sido corrompida pelas tentativas rejeitadas.
    const stillQuoted = await insuranceService.getPolicy(policy.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(stillQuoted.status, 'QUOTED');

    const issued = await insuranceService.issuePolicy(
      policy.id,
      { effectiveDate: '2026-10-05', expiryDate: '2027-10-05', installmentsCount: 12 },
      actor(),
      transaction
    );
    assert.ok(['ACTIVE', 'ISSUED'].includes(issued.status));
  });
});

test('Item 6: openClaim bloqueia sinistro duplicado (mesma descrição, ainda ativo) na mesma apólice', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    await insuranceService.issuePolicy(policy.id, { effectiveDate: '2026-10-05', expiryDate: '2027-10-05' }, actor(), transaction);

    const claim = await insuranceService.openClaim(
      policy.id,
      { description: 'incêndio no depósito', claimAmount: 1000 },
      actor(),
      transaction
    );
    assert.equal(claim.status, 'OPEN');

    await assert.rejects(
      () => insuranceService.openClaim(
        policy.id,
        { description: 'Incêndio no depósito  ', claimAmount: 1000 },
        actor(),
        transaction
      ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INSURANCE_CLAIM_DUPLICATE');
        return true;
      },
      'mesma descrição (normalizada) com um claim ativo precisa ser bloqueada'
    );

    // Evento DIFERENTE na mesma apólice (descrição distinta) continua permitido — o contrato não
    // proíbe múltiplos sinistros legítimos simultâneos pra apólice.
    const secondClaim = await insuranceService.openClaim(
      policy.id,
      { description: 'furto de equipamentos', claimAmount: 500 },
      actor(),
      transaction
    );
    assert.equal(secondClaim.status, 'OPEN');

    // Depois de submeter/liquidar o primeiro claim, reabrir com a MESMA descrição (agora que não
    // há mais claim ativo com ela) volta a ser permitido.
    const submitted = await insuranceService.submitClaim(claim.id, actor(), transaction);
    await insuranceService.confirmClaimSettlement(submitted.externalClaimId, 'SETTLED', 1000, transaction);

    const reopened = await insuranceService.openClaim(
      policy.id,
      { description: 'incêndio no depósito', claimAmount: 1000 },
      actor(),
      transaction
    );
    assert.equal(reopened.status, 'OPEN');
  });
});

test('Item 8: recordMovement de alto valor exige evidenceFileId válido — UUID inventado ou de outra empresa é tratado como ausente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { item, location } = await createItemAndWarehouse(transaction, 1000);
    await receive(transaction, item, location, 50);

    const fakeFileId = '11111111-1111-1111-1111-111111111111';
    await assert.rejects(
      () => movementsService.recordMovement(
        withTenant({
          inventoryItemId: item.id,
          movementType: 'ADJUSTMENT',
          quantity: 10,
          sourceLocationId: location.id,
          reason: 'Ajuste de alto valor com evidência inventada.',
          evidenceFileId: fakeFileId,
        }),
        actor({ canApprove: true }),
        transaction
      ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'INVENTORY_MOVEMENT_EVIDENCE_REQUIRED_HIGH_VALUE');
        return true;
      },
      'evidenceFileId que não aponta para nenhum File precisa ser tratado como evidência ausente'
    );

    // Arquivo real, mas de OUTRA empresa — também não pode contar como evidência válida.
    const [[otherCompanyRow]] = await sequelize.query(
      'SELECT id FROM core.companies WHERE id != :companyId LIMIT 1',
      { replacements: { companyId: tenant.companyId }, transaction }
    );
    if (otherCompanyRow) {
      const foreignFile = await File.create(
        {
          groupId: tenant.groupId,
          companyId: otherCompanyRow.id,
          fileName: 'evidencia-outra-empresa.pdf',
          mimeType: 'application/pdf',
          storageKey: `test/${Date.now()}-foreign.pdf`,
          sizeBytes: 10,
        },
        { transaction }
      );
      await assert.rejects(
        () => movementsService.recordMovement(
          withTenant({
            inventoryItemId: item.id,
            movementType: 'ADJUSTMENT',
            quantity: 10,
            sourceLocationId: location.id,
            reason: 'Ajuste de alto valor com evidência de outro tenant.',
            evidenceFileId: foreignFile.id,
          }),
          actor({ canApprove: true }),
          transaction
        ),
        (err) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, 'INVENTORY_MOVEMENT_EVIDENCE_REQUIRED_HIGH_VALUE');
          return true;
        },
        'evidenceFileId de outra empresa precisa ser tratado como evidência ausente'
      );
    }

    // Arquivo real do MESMO tenant: passa normalmente.
    const ownFile = await File.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        fileName: 'evidencia-valida.pdf',
        mimeType: 'application/pdf',
        storageKey: `test/${Date.now()}-own.pdf`,
        sizeBytes: 10,
      },
      { transaction }
    );
    const movement = await movementsService.recordMovement(
      withTenant({
        inventoryItemId: item.id,
        movementType: 'ADJUSTMENT',
        quantity: 10,
        sourceLocationId: location.id,
        reason: 'Ajuste de alto valor com evidência válida.',
        evidenceFileId: ownFile.id,
      }),
      actor({ canApprove: true }),
      transaction
    );
    assert.equal(movement.evidenceFileId, ownFile.id);
  });
});
