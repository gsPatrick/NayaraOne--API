'use strict';

// Matriz de fechamento do Marco 6 (10/11/2026): Caderno §12 "Updates concorrentes → lock_version".
// Os testes de concorrência existentes provam o lock pessimista (FOR UPDATE); este prova a coluna
// lock_version (controle otimista do Sequelize) em transações COMMITADAS reais: duas conexões leem a
// mesma versão, a primeira grava, a segunda é recusada (nada sobrescrito) e a API responde 409.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { Project, ProjectStage, Budget } = require('../src/models');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const budgetsService = require('../src/features/construction/budgets.service');
const errorHandler = require('../src/middlewares/errorHandler');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
});
after(async () => {
  await sequelize.close();
});
const W = (fields) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...fields });

async function openTenantTx() {
  const t = await sequelize.transaction();
  await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
  await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
  await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
  return t;
}

async function staleWriteIsRejected(Model, id, field, valueA, valueB) {
  const t1 = await openTenantTx();
  const t2 = await openTenantTx();
  try {
    const a = await Model.findByPk(id, { transaction: t1 });
    const b = await Model.findByPk(id, { transaction: t2 });
    assert.equal(a.lockVersion, b.lockVersion, 'as duas conexões leram a mesma versão');
    const versionRead = a.lockVersion;
    a[field] = valueA;
    await a.save({ transaction: t1 });
    await t1.commit();
    b[field] = valueB;
    await assert.rejects(() => b.save({ transaction: t2 }), (err) => err.name === 'SequelizeOptimisticLockError');
    await t2.rollback();
    const final = await withTenantTransaction(tenant, (t) => Model.findByPk(id, { transaction: t }));
    assert.equal(final[field], valueA, 'a gravação com versão velha não sobrescreveu');
    assert.equal(final.lockVersion, versionRead + 1, 'lock_version subiu exatamente uma vez');
  } catch (err) {
    await t1.rollback().catch(() => {});
    await t2.rollback().catch(() => {});
    throw err;
  }
}

test('M6-67: obra — segunda gravação com lock_version velho é recusada (SequelizeOptimisticLockError)', async () => {
  const p = await withTenantTransaction(tenant, (t) => projectsService.createProject(W({ name: `QA M6 Lock ${uniqueSuffix()}` }), tenant.userId, t));
  await staleWriteIsRejected(Project, p.id, 'name', `Versão A ${uniqueSuffix()}`, 'Versão B');
});

test('M6-67: etapa e orçamento — mesma proteção de lock_version', async () => {
  const { stage, budget } = await withTenantTransaction(tenant, async (t) => {
    const p = await projectsService.createProject(W({ name: `QA M6 Lock ${uniqueSuffix()}` }), tenant.userId, t);
    const st = await projectStagesService.createProjectStage(p.id, W({ name: 'Alvenaria', sequence: 1, plannedPct: 100 }), tenant.userId, t);
    const b = await budgetsService.createBudget(p.id, W({}), tenant.userId, t);
    return { stage: st, budget: b };
  });
  await staleWriteIsRejected(ProjectStage, stage.id, 'name', 'Alvenaria A', 'Alvenaria B');
  // Orçamento ainda DRAFT: dois cálculos concorrentes do total — só o primeiro grava.
  await staleWriteIsRejected(Budget, budget.id, 'totalAmount', '1000.00', '2000.00');
});

test('M6-67: o conflito de lock_version chega ao cliente como 409 OPTIMISTIC_LOCK_CONFLICT', async () => {
  const err = new Error('stale');
  err.name = 'SequelizeOptimisticLockError';
  let status = null;
  let body = null;
  const headers = {};
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; }, setHeader(k, v) { headers[k] = v; }, getHeader(k) { return headers[k]; }, set(k, v) { headers[k] = v; return this; }, locals: {}, headersSent: false };
  await errorHandler(err, { method: 'PATCH', originalUrl: '/api/v1/construction/projects/x', path: '/construction/projects/x', headers: {}, get() { return undefined; } }, res, () => {});
  assert.equal(status, 409);
  assert.equal(body.error.code, 'OPTIMISTIC_LOCK_CONFLICT');
});
