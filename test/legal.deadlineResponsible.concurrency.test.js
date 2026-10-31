'use strict';

/**
 * Concorrencia da troca de responsavel do prazo: dois PATCH simultaneos no mesmo prazo se
 * serializam (lock processo -> prazo), a auditoria fica encadeada (o `before` do segundo e o
 * `after` do primeiro) e nao ha deadlock. Usa transacoes REAIS (commit), por isso limpa o que cria.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, uniqueSuffix } = require('./testHelpers');
const legalCasesService = require('../src/features/legal/legalCases.service');
const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
const { LegalDeadline, LegalCase, AuditLog, User, UserMembership } = require('../src/models');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
});
after(async () => {
  await sequelize.close();
});

async function inTenantTx(fn) {
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :userId', { replacements: { userId: tenant.userId }, transaction });
    const out = await fn(transaction);
    await transaction.commit();
    return out;
  } catch (err) {
    await transaction.rollback().catch(() => {});
    throw err;
  }
}

test('Dois PATCH simultaneos de responsavel no mesmo prazo: auditoria encadeada, sem deadlock', async () => {
  const created = { users: [], caseId: null, deadlineId: null };
  try {
    const setup = await inTenantTx(async (transaction) => {
      const users = [];
      for (let i = 0; i < 3; i += 1) {
        const sfx = uniqueSuffix();
        const u = await User.create({ name: `Conc ${sfx}`, email: `conc-${sfx}@example.test`, passwordHash: 'x', status: 'ACTIVE' }, { transaction });
        await UserMembership.create({ userId: u.id, groupId: tenant.groupId, companyId: tenant.companyId, status: 'ACTIVE' }, { transaction });
        users.push(u);
      }
      const legalCase = await legalCasesService.createLegalCase(
        { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `Conc ${uniqueSuffix()}`, responsibleUserId: tenant.userId, escalationUserId: tenant.userId },
        tenant.userId,
        transaction
      );
      const deadline = await legalDeadlinesService.createLegalDeadline(
        legalCase.id,
        { description: `Prazo conc ${uniqueSuffix()}`, dueAt: new Date(Date.now() + 20 * 86400000), sourceEvent: 'teste', responsibleUserId: users[0].id },
        tenant.userId,
        transaction
      );
      return { users, caseId: legalCase.id, deadlineId: deadline.id };
    });
    Object.assign(created, setup);
    const [, b, c] = setup.users;

    // Interleaving deterministico: a transacao 1 troca o responsavel e segura o commit; a 2
    // comeca enquanto a 1 esta aberta. Com o lock, a 2 espera e le o estado ja gravado; sem ele
    // leria o `before` velho (last-write-wins).
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const tx1 = await sequelize.transaction();
    let secondTx;
    try {
      for (const q of ['app.group_id', 'app.company_id', 'app.user_id']) {
        const value = { 'app.group_id': tenant.groupId, 'app.company_id': tenant.companyId, 'app.user_id': tenant.userId }[q];
        await sequelize.query(`SET LOCAL ${q} = :value`, { replacements: { value }, transaction: tx1 });
      }
      await legalDeadlinesService.updateLegalDeadline(setup.deadlineId, { responsibleUserId: b.id }, tenant.userId, tx1);
      secondTx = inTenantTx((transaction) =>
        legalDeadlinesService.updateLegalDeadline(setup.deadlineId, { responsibleUserId: c.id }, tenant.userId, transaction)
      );
      secondTx.catch(() => {});
      await sleep(500);
      await tx1.commit();
    } catch (err) {
      await tx1.rollback().catch(() => {});
      throw err;
    }
    await secondTx;

    const logs = await inTenantTx((transaction) =>
      AuditLog.findAll({ where: { entityId: setup.deadlineId, action: 'legal.deadline.update' }, order: [['occurredAt', 'ASC']], transaction })
    );
    assert.equal(logs.length, 2);
    const [first, second] = logs;
    assert.equal(first.beforeJson.responsibleUserId, setup.users[0].id);
    assert.equal(first.afterJson.responsibleUserId, b.id);
    assert.equal(second.afterJson.responsibleUserId, c.id);
    assert.equal(second.beforeJson.responsibleUserId, first.afterJson.responsibleUserId, 'o before do segundo e o after do primeiro');
    assert.notEqual(second.afterJson.responsibleUserId, first.afterJson.responsibleUserId);
    const final = await inTenantTx((transaction) => LegalDeadline.findByPk(setup.deadlineId, { transaction }));
    assert.equal(final.responsibleUserId, second.afterJson.responsibleUserId);
  } finally {
    // Limpeza best-effort (auditoria pode ser append-only; o banco de teste e descartavel).
    await inTenantTx(async (transaction) => {
      if (created.deadlineId) await LegalDeadline.destroy({ where: { id: created.deadlineId }, transaction });
      if (created.caseId) await LegalCase.destroy({ where: { id: created.caseId }, transaction });
      for (const u of created.users) {
        await UserMembership.destroy({ where: { userId: u.id }, transaction });
        await User.destroy({ where: { id: u.id }, transaction });
      }
    }).catch(() => {});
  }
});
