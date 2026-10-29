'use strict';

/**
 * Auditoria da cliente, Marco 5 (achado 2, contorno): o criterio de prazo CRITICAL
 * (responsavel efetivo + destino de escalonamento) tambem vale ao REABRIR um prazo concluido.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const legalCasesService = require('../src/features/legal/legalCases.service');
const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
const AppError = require('../src/utils/AppError');
const { LegalDeadline, LegalCase } = require('../src/models');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
});
after(async () => {
  await sequelize.close();
});

const FUTURE = () => new Date(Date.now() + 20 * 86400000);

function expectCode(code, status) {
  return (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.code, code);
    assert.equal(err.statusCode, status);
    return true;
  };
}

async function concludedCritical(transaction) {
  const legalCase = await legalCasesService.createLegalCase(
    { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `Reabrir ${uniqueSuffix()}`, responsibleUserId: tenant.userId, escalationUserId: tenant.userId },
    tenant.userId,
    transaction
  );
  const d = await legalDeadlinesService.createLegalDeadline(
    legalCase.id,
    { description: `Critico ${uniqueSuffix()}`, dueAt: FUTURE(), sourceEvent: 'teste', criticality: 'CRITICAL' },
    tenant.userId,
    transaction
  );
  await legalDeadlinesService.updateLegalDeadline(d.id, { status: 'DONE', conclusionNote: 'Feito.' }, tenant.userId, transaction);
  return { legalCase, d };
}

test('Contorno: tirar escalonamento/responsavel com o CRITICAL concluido e reabrir -> reabertura recusada (422), prazo continua DONE', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { legalCase, d } = await concludedCritical(transaction);
    await legalCasesService.updateLegalCase(legalCase.id, { escalationUserId: null }, tenant.userId, transaction);
    await assert.rejects(
      () => legalDeadlinesService.updateLegalDeadline(d.id, { status: 'PENDING' }, tenant.userId, transaction),
      expectCode('LEGAL_DEADLINE_CRITICAL_ESCALATION_REQUIRED', 422)
    );
    await LegalCase.update({ escalationUserId: tenant.userId, responsibleUserId: null }, { where: { id: legalCase.id }, transaction });
    await assert.rejects(
      () => legalDeadlinesService.updateLegalDeadline(d.id, { status: 'PENDING' }, tenant.userId, transaction),
      expectCode('LEGAL_DEADLINE_CRITICAL_RESPONSIBLE_REQUIRED', 422)
    );
    const fresh = await LegalDeadline.findByPk(d.id, { transaction });
    assert.equal(fresh.status, 'DONE');
  });
});

test('Fluxo legitimo: reabrir CRITICAL com responsavel e escalonamento mantidos funciona; reabrir MEDIUM nao exige nada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { legalCase, d } = await concludedCritical(transaction);
    const reopened = await legalDeadlinesService.updateLegalDeadline(d.id, { status: 'PENDING' }, tenant.userId, transaction);
    assert.equal(reopened.status, 'PENDING');
    // MEDIUM concluido, processo sem escalonamento: reabertura livre
    await LegalCase.update({ escalationUserId: null, responsibleUserId: null }, { where: { id: legalCase.id }, transaction });
    const m = await legalDeadlinesService.createLegalDeadline(legalCase.id, { description: 'comum', dueAt: FUTURE(), sourceEvent: 'teste' }, tenant.userId, transaction);
    await legalDeadlinesService.updateLegalDeadline(m.id, { status: 'DONE', conclusionNote: 'ok' }, tenant.userId, transaction);
    const mr = await legalDeadlinesService.updateLegalDeadline(m.id, { status: 'PENDING' }, tenant.userId, transaction);
    assert.equal(mr.status, 'PENDING');
  });
});
