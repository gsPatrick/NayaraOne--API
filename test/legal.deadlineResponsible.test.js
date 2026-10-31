'use strict';

/**
 * Reteste da cliente (Marcos 3-6): "alterar responsibleUserId pelo PATCH manteve o responsavel
 * anterior". Prazo juridico: o responsavel pode ser atribuido na criacao e trocado/removido
 * depois (PATCH), sempre com usuario de vinculo ativo na empresa, auditoria antes/depois.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const legalCasesService = require('../src/features/legal/legalCases.service');
const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
const AppError = require('../src/utils/AppError');
const { LegalDeadline, AuditLog, User, UserMembership } = require('../src/models');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
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

async function newUser(transaction, { member = true } = {}) {
  const sfx = uniqueSuffix();
  const user = await User.create({ name: `Resp ${sfx}`, email: `resp-${sfx}@example.test`, passwordHash: 'x', status: 'ACTIVE' }, { transaction });
  if (member) {
    await UserMembership.create(
      { userId: user.id, groupId: tenant.groupId, companyId: tenant.companyId, status: 'ACTIVE' },
      { transaction }
    );
  }
  return user;
}

async function newCase(transaction) {
  return legalCasesService.createLegalCase(
    { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `Resp ${uniqueSuffix()}`, responsibleUserId: tenant.userId, escalationUserId: tenant.userId },
    tenant.userId,
    transaction
  );
}

function newDeadline(legalCase, transaction, extra = {}) {
  return legalDeadlinesService.createLegalDeadline(
    legalCase.id,
    { description: `Prazo ${uniqueSuffix()}`, dueAt: new Date(Date.now() + 20 * 86400000), sourceEvent: 'teste', ...extra },
    tenant.userId,
    transaction
  );
}

test('Criacao com responsavel grava o responsavel', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const a = await newUser(transaction);
    const d = await newDeadline(await newCase(transaction), transaction, { responsibleUserId: a.id });
    assert.equal((await LegalDeadline.findByPk(d.id, { transaction })).responsibleUserId, a.id);
  });
});

test('PATCH troca o responsavel, persiste e grava auditoria antes/depois', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const a = await newUser(transaction);
    const b = await newUser(transaction);
    const d = await newDeadline(await newCase(transaction), transaction, { responsibleUserId: a.id });
    const out = await legalDeadlinesService.updateLegalDeadline(d.id, { responsibleUserId: b.id, changeReason: 'Colega assume' }, tenant.userId, transaction);
    assert.equal(out.responsibleUserId, b.id);
    assert.equal((await LegalDeadline.findByPk(d.id, { transaction })).responsibleUserId, b.id);
    const log = await AuditLog.findOne({ where: { entityId: d.id, action: 'legal.deadline.update' }, order: [['occurredAt', 'DESC']], transaction });
    assert.ok(log, 'auditoria gravada');
    assert.equal(log.beforeJson.responsibleUserId, a.id);
    assert.equal(log.afterJson.responsibleUserId, b.id);
    assert.match(log.reason, /Colega assume/);
  });
});

test('PATCH atribui responsavel a prazo que nasceu sem e permite remover (prazo nao critico, nao vencido)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const a = await newUser(transaction);
    const d = await newDeadline(await newCase(transaction), transaction);
    assert.equal(d.responsibleUserId, null);
    assert.equal((await legalDeadlinesService.updateLegalDeadline(d.id, { responsibleUserId: a.id }, tenant.userId, transaction)).responsibleUserId, a.id);
    assert.equal((await legalDeadlinesService.updateLegalDeadline(d.id, { responsibleUserId: null }, tenant.userId, transaction)).responsibleUserId, null);
  });
});

test('Usuario sem vinculo na empresa (outro tenant/inexistente) e recusado na criacao e no PATCH, sem alterar nada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const a = await newUser(transaction);
    const stranger = await newUser(transaction, { member: false });
    const legalCase = await newCase(transaction);
    await assert.rejects(
      () => newDeadline(legalCase, transaction, { responsibleUserId: stranger.id }),
      expectCode('LEGAL_DEADLINE_RESPONSIBLE_NOT_IN_TENANT', 422)
    );
    const d = await newDeadline(legalCase, transaction, { responsibleUserId: a.id });
    for (const id of [stranger.id, '11111111-1111-4111-8111-111111111111']) {
      await assert.rejects(
        () => legalDeadlinesService.updateLegalDeadline(d.id, { responsibleUserId: id }, tenant.userId, transaction),
        expectCode('LEGAL_DEADLINE_RESPONSIBLE_NOT_IN_TENANT', 422)
      );
    }
    await assert.rejects(
      () => legalDeadlinesService.updateLegalDeadline(d.id, { responsibleUserId: 'nao-e-uuid' }, tenant.userId, transaction),
      expectCode('LEGAL_DEADLINE_VALIDATION', 400)
    );
    assert.equal((await LegalDeadline.findByPk(d.id, { transaction })).responsibleUserId, a.id);
  });
});

test('Vinculo inativo nao serve como responsavel', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const inactive = await newUser(transaction);
    await UserMembership.update({ status: 'INACTIVE' }, { where: { userId: inactive.id }, transaction });
    const d = await newDeadline(await newCase(transaction), transaction);
    await assert.rejects(
      () => legalDeadlinesService.updateLegalDeadline(d.id, { responsibleUserId: inactive.id }, tenant.userId, transaction),
      expectCode('LEGAL_DEADLINE_RESPONSIBLE_NOT_IN_TENANT', 422)
    );
  });
});

test('Remover responsavel de prazo pendente ja vencido e recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const a = await newUser(transaction);
    const legalCase = await newCase(transaction);
    const overdue = await newDeadline(legalCase, transaction, { responsibleUserId: a.id });
    await LegalDeadline.update({ dueAt: new Date(Date.now() - 86400000) }, { where: { id: overdue.id }, transaction });
    await assert.rejects(
      () => legalDeadlinesService.updateLegalDeadline(overdue.id, { responsibleUserId: null }, tenant.userId, transaction),
      expectCode('LEGAL_DEADLINE_RESPONSIBLE_REQUIRED', 400)
    );
    assert.equal((await LegalDeadline.findByPk(overdue.id, { transaction })).responsibleUserId, a.id);
  });
});

test('Remarcar (dueAt) continua exigindo motivo e preserva o responsavel', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const a = await newUser(transaction);
    const d = await newDeadline(await newCase(transaction), transaction, { responsibleUserId: a.id });
    const novo = new Date(Date.now() + 40 * 86400000);
    await assert.rejects(
      () => legalDeadlinesService.updateLegalDeadline(d.id, { dueAt: novo }, tenant.userId, transaction),
      expectCode('LEGAL_DEADLINE_CHANGE_REASON_REQUIRED', 400)
    );
    const out = await legalDeadlinesService.updateLegalDeadline(d.id, { dueAt: novo, changeReason: 'Intimação adiada' }, tenant.userId, transaction);
    assert.equal(out.responsibleUserId, a.id);
    assert.equal(new Date(out.dueAt).getTime(), novo.getTime());
  });
});
