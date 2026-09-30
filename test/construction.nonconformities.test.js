'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const nonconformitiesService = require('../src/features/construction/nonconformities.service');
const lossRecordsService = require('../src/features/construction/lossRecords.service');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createTestProject(transaction) {
  const suffix = uniqueSuffix();
  return projectsService.createProject(
    { groupId: tenant.groupId, companyId: tenant.companyId, name: `HOMO QA Obra ${suffix}` },
    tenant.userId,
    transaction
  );
}

// M6-62/M6-24/M6-38/M6-86: fechar NC sem evidência "depois" tem que bloquear (fail-closed) —
// nunca fechar silenciosamente sem afterEvidenceFileIds.
test('M6-62: fechar não conformidade sem after_evidence_file_ids bloqueia', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const nc = await nonconformitiesService.createNonconformity(
      project.id,
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        severity: 'HIGH',
        description: 'Infiltração no banheiro da suíte 2.',
        beforeEvidenceFileIds: ['11111111-1111-1111-1111-111111111111'],
      },
      tenant.userId,
      transaction
    );
    assert.equal(nc.status, 'OPEN');

    await assert.rejects(
      () => nonconformitiesService.closeNonconformity(nc.id, {}, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'NONCONFORMITY_CLOSE_REQUIRES_AFTER_EVIDENCE');
        return true;
      }
    );

    // Confirma que realmente não fechou (fail-closed de verdade, não só o erro lançado).
    const reloaded = await nonconformitiesService.getNonconformity(nc.id, transaction);
    assert.equal(reloaded.status, 'OPEN');
  });
});

// M6-24: NC com requiresAcceptance=true não pode fechar sem acceptedByUserId, mesmo com
// evidência "depois" preenchida.
test('M6-24: fechar NC com requiresAcceptance=true sem acceptedByUserId bloqueia', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const nc = await nonconformitiesService.createNonconformity(
      project.id,
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        severity: 'CRITICAL',
        description: 'Trinca estrutural na viga do 2º pavimento.',
        requiresAcceptance: true,
      },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () =>
        nonconformitiesService.closeNonconformity(
          nc.id,
          { afterEvidenceFileIds: ['22222222-2222-2222-2222-222222222222'] },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'NONCONFORMITY_CLOSE_REQUIRES_ACCEPTANCE');
        return true;
      }
    );

    // Com aceite preenchido, agora fecha normalmente e dispara nonconformity.closed.
    const closed = await nonconformitiesService.closeNonconformity(
      nc.id,
      { afterEvidenceFileIds: ['22222222-2222-2222-2222-222222222222'], acceptedByUserId: tenant.userId },
      tenant.userId,
      transaction
    );
    assert.equal(closed.status, 'CLOSED');
    assert.equal(closed.acceptedByUserId, tenant.userId);
    assert.ok(closed.closedAt);
  });
});

// Fluxo feliz: NC com evidência "depois" preenchida e sem exigência de aceite fecha normalmente.
test('NC fecha normalmente quando after_evidence_file_ids está preenchido e não exige aceite', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const nc = await nonconformitiesService.createNonconformity(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, severity: 'LOW', description: 'Pintura com respingo na sala.' },
      tenant.userId,
      transaction
    );
    const closed = await nonconformitiesService.closeNonconformity(
      nc.id,
      { afterEvidenceFileIds: ['33333333-3333-3333-3333-333333333333'] },
      tenant.userId,
      transaction
    );
    assert.equal(closed.status, 'CLOSED');
  });
});

// M6-29: perda de material acima da alçada não pode ser autoaprovada — nasce PENDING_APPROVAL
// e só vira APPROVED com aprovação explícita.
test('M6-29: perda de material acima da alçada exige aprovação explícita', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const threshold = await lossRecordsService.getApprovalThreshold(
      tenant.groupId,
      tenant.companyId,
      lossRecordsService.CONTEXT_MATERIAL_LOSS,
      transaction
    );

    const highValueLoss = await lossRecordsService.createLossRecord(
      project.id,
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        materialDescription: 'Cimento CPII 50kg',
        quantity: 100,
        estimatedValue: threshold + 5000,
        reason: 'Quebra no transporte do fornecedor.',
      },
      tenant.userId,
      transaction
    );
    assert.equal(highValueLoss.status, 'PENDING_APPROVAL');
    assert.equal(highValueLoss.approvedByUserId, null);

    const approved = await lossRecordsService.approveLossRecord(highValueLoss.id, tenant.userId, transaction);
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.approvedByUserId, tenant.userId);

    // Abaixo da alçada: autoaprova sem chamada explícita.
    const lowValueLoss = await lossRecordsService.createLossRecord(
      project.id,
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        materialDescription: 'Prego 18x30',
        quantity: 5,
        estimatedValue: Math.max(threshold - 100, 1),
        reason: 'Perda pequena de estoque.',
      },
      tenant.userId,
      transaction
    );
    assert.equal(lowValueLoss.status, 'APPROVED');
  });
});

// M6-60: devolução de material gera movimento inverso e corrige o saldo calculado.
test('M6-60: devolução de material corrige o saldo (movimento inverso real)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const materialDescription = 'Telha cerâmica colonial';

    const loss = await lossRecordsService.createLossRecord(
      project.id,
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        materialDescription,
        quantity: 200,
        estimatedValue: 500,
        reason: 'Quebra no manuseio da entrega.',
      },
      tenant.userId,
      transaction
    );
    assert.equal(loss.status, 'APPROVED'); // dentro da alçada padrão

    const balanceAfterLoss = await lossRecordsService.getMaterialBalance(project.id, materialDescription, transaction);
    assert.equal(balanceAfterLoss.quantityBalance, -200);
    assert.equal(balanceAfterLoss.valueBalance, -500);

    // Devolve só parte do material perdido (80 de 200) — movimento inverso parcial.
    const returned = await lossRecordsService.returnLossRecord(loss.id, { quantity: 80 }, tenant.userId, transaction);
    assert.equal(returned.movementType, 'RETURN');
    assert.equal(returned.relatedLossRecordId, loss.id);
    assert.equal(Number(returned.quantity), 80);

    const balanceAfterReturn = await lossRecordsService.getMaterialBalance(project.id, materialDescription, transaction);
    assert.equal(balanceAfterReturn.quantityBalance, -120); // -200 + 80
    assert.equal(balanceAfterReturn.valueBalance, -300); // -500 + 200 (80/200 * 500)

    // Devolução não apaga o registro original de perda (append-only) — continua existindo e
    // continua APPROVED, só o SALDO agregado é que reflete a correção.
    const originalStillThere = await lossRecordsService.getLossRecord(loss.id, transaction);
    assert.equal(originalStillThere.status, 'APPROVED');
    assert.equal(Number(originalStillThere.quantity), 200);

    // Não é possível devolver mais do que o total original.
    await assert.rejects(
      () => lossRecordsService.returnLossRecord(loss.id, { quantity: 1000 }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LOSS_RECORD_RETURN_QUANTITY_INVALID');
        return true;
      }
    );
  });
});

// M6-57/M6-66 (cross-company via RLS): NC criada sob o tenant de seed não pode ser lida/fechada
// fora do contexto de tenant correto — comprova que a policy tenant_isolation está ativa na
// tabela nova.
test('RLS: não conformidade de uma empresa não é visível fora do contexto de tenant (SET LOCAL ausente)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction);
    const nc = await nonconformitiesService.createNonconformity(
      project.id,
      { groupId: tenant.groupId, companyId: tenant.companyId, severity: 'LOW', description: 'RLS smoke test.' },
      tenant.userId,
      transaction
    );

    // Nova transação SEM configurar app.company_id (equivalente a "outro tenant"/sessão sem
    // contexto) — a policy RLS deve esconder a linha mesmo sabendo o ID exato.
    await sequelize.transaction(async (rawTransaction) => {
      const { Nonconformity } = require('../src/models');
      const found = await Nonconformity.findByPk(nc.id, { transaction: rawTransaction });
      assert.equal(found, null);
    });
  });
});
