'use strict';

/**
 * legal.deadlineAccountability.test.js — auditoria técnica independente da Nayara
 * (PDF "Auditoria_Marcos4_5_Patrick.pdf", achados A07/A08/A09): prazo jurídico crítico podia
 * nascer sem responsável, ser concluído sem evidência/nota, e ter o vencimento alterado sem
 * justificativa. Os 3 cenários abaixo reproduzem exatamente isso contra o Postgres real (não
 * fixtures em memória), dentro de uma transação com rollback.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const legalCasesService = require('../src/features/legal/legalCases.service');
const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
const AppError = require('../src/utils/AppError');
const { File } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createCase(transaction, suffix) {
  return legalCasesService.createLegalCase(
    { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `A07/A08/A09 ${suffix}`, responsibleUserId: tenant.userId },
    tenant.userId,
    transaction
  );
}

async function createFile(transaction, suffix) {
  return File.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      storageKey: `legal-accountability/${suffix}.pdf`,
      fileName: `evidencia-${suffix}.pdf`,
      mimeType: 'application/pdf',
      uploadedByUserId: tenant.userId,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

test('A07: prazo que já nasce vencido sem responsável é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const legalCase = await createCase(transaction, suffix);

    await assert.rejects(
      () =>
        legalDeadlinesService.createLegalDeadline(
          legalCase.id,
          { description: `Prazo fictício vencido ${suffix}`, dueAt: new Date('2020-01-01'), sourceDocument: 'decisão fictícia' },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_DEADLINE_RESPONSIBLE_REQUIRED');
        return true;
      }
    );

    // Controle positivo: com responsável, o mesmo prazo vencido é aceito normalmente.
    const deadline = await legalDeadlinesService.createLegalDeadline(
      legalCase.id,
      { description: `Prazo fictício vencido ${suffix}`, dueAt: new Date('2020-01-01'), sourceDocument: 'decisão fictícia', responsibleUserId: tenant.userId },
      tenant.userId,
      transaction
    );
    assert.equal(deadline.responsibleUserId, tenant.userId);
  });
});

test('A07 (controle): prazo com vencimento futuro não exige responsável', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const legalCase = await createCase(transaction, suffix);
    const deadline = await legalDeadlinesService.createLegalDeadline(
      legalCase.id,
      { description: `Prazo futuro ${suffix}`, dueAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), sourceEvent: 'teste automatizado' },
      tenant.userId,
      transaction
    );
    assert.equal(deadline.responsibleUserId, null);
  });
});

test('A08: concluir prazo (status DONE) sem evidência nem nota é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const legalCase = await createCase(transaction, suffix);
    const deadline = await legalDeadlinesService.createLegalDeadline(
      legalCase.id,
      { description: `Prazo a concluir ${suffix}`, dueAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), sourceEvent: 'teste automatizado' },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => legalDeadlinesService.updateLegalDeadline(deadline.id, { status: 'DONE' }, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_DEADLINE_CONCLUSION_PROOF_REQUIRED');
        return true;
      }
    );

    // Controle positivo: com nota, a conclusão é aceita.
    const concluded = await legalDeadlinesService.updateLegalDeadline(
      deadline.id,
      { status: 'DONE', conclusionNote: 'Contestação protocolada no sistema do tribunal.' },
      tenant.userId,
      transaction
    );
    assert.equal(concluded.status, 'DONE');
    assert.equal(concluded.conclusionNote, 'Contestação protocolada no sistema do tribunal.');
  });
});

test('A08 (controle): concluir com evidência de arquivo válido é aceito', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const legalCase = await createCase(transaction, suffix);
    const deadline = await legalDeadlinesService.createLegalDeadline(
      legalCase.id,
      { description: `Prazo a concluir com evidência ${suffix}`, dueAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), sourceEvent: 'teste automatizado' },
      tenant.userId,
      transaction
    );
    const file = await createFile(transaction, suffix);

    const concluded = await legalDeadlinesService.updateLegalDeadline(
      deadline.id,
      { status: 'DONE', conclusionEvidenceFileId: file.id },
      tenant.userId,
      transaction
    );
    assert.equal(concluded.status, 'DONE');
    assert.equal(concluded.conclusionEvidenceFileId, file.id);
  });
});

test('A09: mudar o vencimento sem justificativa é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const legalCase = await createCase(transaction, suffix);
    const deadline = await legalDeadlinesService.createLegalDeadline(
      legalCase.id,
      { description: `Prazo a mudar ${suffix}`, dueAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), sourceEvent: 'teste automatizado' },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () =>
        legalDeadlinesService.updateLegalDeadline(
          deadline.id,
          { dueAt: new Date('2030-01-01') },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_DEADLINE_CHANGE_REASON_REQUIRED');
        return true;
      }
    );

    // Controle positivo: com justificativa, a mudança é aceita e vira o motivo real na auditoria.
    const updated = await legalDeadlinesService.updateLegalDeadline(
      deadline.id,
      { dueAt: new Date('2030-01-01'), changeReason: 'Prazo judicial prorrogado por decisão do juiz.' },
      tenant.userId,
      transaction
    );
    assert.equal(new Date(updated.dueAt).toISOString(), new Date('2030-01-01').toISOString());
  });
});

test('A09 (controle): atualizar só a descrição, sem mudar dueAt, não exige justificativa', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const legalCase = await createCase(transaction, suffix);
    const deadline = await legalDeadlinesService.createLegalDeadline(
      legalCase.id,
      { description: `Prazo original ${suffix}`, dueAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), sourceEvent: 'teste automatizado' },
      tenant.userId,
      transaction
    );
    const updated = await legalDeadlinesService.updateLegalDeadline(
      deadline.id,
      { description: `Prazo renomeado ${suffix}` },
      tenant.userId,
      transaction
    );
    assert.equal(updated.description, `Prazo renomeado ${suffix}`);
  });
});
