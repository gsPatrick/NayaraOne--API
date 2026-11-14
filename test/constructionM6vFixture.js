'use strict';

// Apoio dos testes da verificação independente do Marco 6 (test/construction.m6v.*): outra empresa no mesmo grupo,
// outro membro ativo da empresa, alçadas configuradas e a obra com orçamento aprovado. Tudo dentro da transação do
// teste (rollback no fim). Arquivos reais pelo módulo de arquivos (constructionEvidenceFixture.js).
const crypto = require('node:crypto');
const { sequelize, Company, User, UserMembership, Role } = require('../src/models');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const budgetsService = require('../src/features/construction/budgets.service');
const budgetLinesService = require('../src/features/construction/budgetLines.service');
const marginRulesService = require('../src/features/construction/marginRules.service');
const { upsertApprovalThreshold } = require('../src/features/construction/lossRecords.service');
const { evidenceIds } = require('./constructionEvidenceFixture');

const W = (tenant, fields = {}) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...fields });

async function setCompany(transaction, companyId) {
  await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: companyId }, transaction });
}

/** Cria outra empresa no grupo e roda `fn` no contexto dela; volta ao tenant no fim. */
async function inOtherCompany(tenant, transaction, fn) {
  const suffix = crypto.randomBytes(4).toString('hex');
  const other = await Company.create({ groupId: tenant.groupId, name: `M6V outra ${suffix}`, status: 'ACTIVE' }, { transaction });
  await setCompany(transaction, other.id);
  try {
    return await fn(other);
  } finally {
    await setCompany(transaction, tenant.companyId);
  }
}

/** Usuário novo com vínculo `status` na empresa do tenant (ACTIVE por padrão). */
async function createMember(tenant, transaction, { status = 'ACTIVE', companyId = tenant.companyId } = {}) {
  const suffix = crypto.randomBytes(6).toString('hex');
  const user = await User.create({ name: `M6V membro ${suffix}`, email: `m6v-${suffix}@ci.nayaraone.test`, passwordHash: 'x'.repeat(60), status: 'ACTIVE' }, { transaction });
  const role = await Role.findOne({ where: { companyId }, transaction });
  await UserMembership.create({ userId: user.id, groupId: tenant.groupId, companyId, roleId: role ? role.id : null, status }, { transaction });
  return user;
}

async function setThresholds(tenant, transaction, { MATERIAL_LOSS, WARRANTY_RESOLUTION } = {}) {
  if (MATERIAL_LOSS !== undefined) await upsertApprovalThreshold(W(tenant, { context: 'MATERIAL_LOSS', maxAutoApproveAmount: MATERIAL_LOSS }), tenant.userId, transaction);
  if (WARRANTY_RESOLUTION !== undefined) await upsertApprovalThreshold(W(tenant, { context: 'WARRANTY_RESOLUTION', maxAutoApproveAmount: WARRANTY_RESOLUTION }), tenant.userId, transaction);
}

/** Obra com orçamento aprovado (linha `baseline`) e uma etapa com responsável; devolve { project, budget, stage }. */
async function projectWithApprovedBudget(tenant, transaction, { baseline = 80000, stageCode, responsibleUserId } = {}) {
  const s = crypto.randomBytes(4).toString('hex');
  const project = await projectsService.createProject(W(tenant, { name: `M6V obra ${s}`, responsibleUserId: tenant.userId }), tenant.userId, transaction);
  await marginRulesService.createMarginRule(W(tenant, { minMarginPct: 1 }), tenant.userId, transaction);
  const budget = await budgetsService.createBudget(project.id, W(tenant), tenant.userId, transaction);
  await budgetLinesService.createBudgetLine(project.id, W(tenant, { budgetId: budget.id, category: 'Estrutura', plannedAmount: baseline }), tenant.userId, transaction);
  const approved = await budgetsService.approveBudget(budget.id, tenant.userId, transaction);
  const stage = await projectStagesService.createProjectStage(
    project.id,
    W(tenant, { name: 'Fundação', stageCode: stageCode || `FUN-${s}`, sequence: 1, plannedPct: 100, plannedCost: baseline, responsibleUserId: responsibleUserId || tenant.userId }),
    tenant.userId,
    transaction
  );
  return { project, budget: approved, stage };
}

module.exports = { W, setCompany, inOtherCompany, createMember, setThresholds, projectWithApprovedBudget, evidenceIds };
