'use strict';

/**
 * Auditoria da cliente, Marco 5 (achado 3, contorno): o status do PATCH e validado e
 * normalizado; nenhuma variacao ("done", " DONE ", "Done") pula a exigencia de prova.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { prepararOrigem, origem } = require('./helpers/prazoOrigem');
const legalCasesService = require('../src/modules/legal/cases/legal-case.service');
const legalDeadlinesService = require('../src/modules/legal/cases/deadline.service');
const AppError = require('../src/utils/AppError');
const { LegalDeadline } = require('../src/models');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
  await prepararOrigem(tenant);
});
after(async () => {
  await sequelize.close();
});

function expectCode(code, status) {
  return (err) => {
    assert.ok(err instanceof AppError, String(err));
    assert.equal(err.code, code);
    assert.equal(err.statusCode, status);
    return true;
  };
}

async function pending(transaction) {
  const legalCase = await legalCasesService.createLegalCase(
    { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `Status ${uniqueSuffix()}`, responsibleUserId: tenant.userId },
    tenant.userId,
    transaction
  );
  return legalDeadlinesService.createLegalDeadline(
    legalCase.id,
    { description: `Prazo ${uniqueSuffix()}`, dueAt: new Date(Date.now() + 20 * 86400000), sourceEvent: 'teste', sourceFileId: origem(tenant) },
    tenant.userId,
    transaction
  );
}

test('Variacoes de DONE sem prova: recusadas (422) e o prazo continua PENDING', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const d = await pending(transaction);
    for (const status of ['done', 'Done', ' DONE ', 'dOnE', '​DONE']) {
      await assert.rejects(
        () => legalDeadlinesService.updateLegalDeadline(d.id, { status }, tenant.userId, transaction),
        expectCode('LEGAL_DEADLINE_CONCLUSION_PROOF_REQUIRED', 422)
      );
    }
    assert.equal((await LegalDeadline.findByPk(d.id, { transaction })).status, 'PENDING');
  });
});

test('Status desconhecido ou que nao e texto: recusado (400) e nada gravado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const d = await pending(transaction);
    // CANCELLED passou a ser estado válido (cancelamento com motivo, m5fech.juridico.prazosLivro); ARCHIVED segue inventado.
    for (const status of ['XYZ', '', '   ', 'ARCHIVED', null, 0, false, {}, ['DONE'], 7]) {
      await assert.rejects(
        () => legalDeadlinesService.updateLegalDeadline(d.id, { status }, tenant.userId, transaction),
        expectCode('LEGAL_DEADLINE_VALIDATION', 400)
      );
    }
    assert.equal((await LegalDeadline.findByPk(d.id, { transaction })).status, 'PENDING');
  });
});

test('Fluxo legitimo: "done" com nota conclui gravando DONE canonico; "pending" reabre; PENDING/DONE exatos seguem iguais', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const d = await pending(transaction);
    const done = await legalDeadlinesService.updateLegalDeadline(d.id, { status: 'done', conclusionNote: 'Peticao protocolada.' }, tenant.userId, transaction);
    assert.equal(done.status, 'DONE');
    const reopened = await legalDeadlinesService.updateLegalDeadline(d.id, { status: ' pending ' }, tenant.userId, transaction);
    assert.equal(reopened.status, 'PENDING');
    assert.equal(reopened.lastAlertedSeverity, null);
    const again = await legalDeadlinesService.updateLegalDeadline(d.id, { status: 'DONE' }, tenant.userId, transaction);
    assert.equal(again.status, 'DONE');
    // atualizacao sem status continua livre
    const sem = await legalDeadlinesService.updateLegalDeadline(d.id, { description: 'Descricao revisada' }, tenant.userId, transaction);
    assert.equal(sem.status, 'DONE');
  });
});
