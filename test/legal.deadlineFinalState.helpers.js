'use strict';

// Apoio dos testes de estado final do PATCH de prazo juridico (servico, HTTP e concorrencia).
const { sequelize, uniqueSuffix } = require('./testHelpers');
const legalCasesService = require('../src/features/legal/legalCases.service');
const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
const { LegalCase, LegalDeadline, AuditLog, User, UserMembership } = require('../src/models');

const FUTURE = () => new Date(Date.now() + 20 * 86400000);
const PAST = () => new Date(Date.now() - 3 * 86400000);

async function newUser(tenant, transaction) {
  const sfx = uniqueSuffix();
  const user = await User.create({ name: `FS ${sfx}`, email: `fs-${sfx}@example.test`, passwordHash: 'x', status: 'ACTIVE' }, { transaction });
  await UserMembership.create({ userId: user.id, groupId: tenant.groupId, companyId: tenant.companyId, status: 'ACTIVE' }, { transaction });
  return user;
}

/**
 * Processo SEM responsavel proprio (com escalonamento, salvo `escalation:false`) e prazo CRITICAL
 * concluido (DONE), com responsavel `responsibleUserId` (ou sem). O responsavel do processo e
 * tirado direto no banco depois de criar o prazo (o servico do processo recusaria a retirada).
 */
async function concludedCriticalWithoutCaseResponsible(tenant, transaction, { responsibleUserId, caseResponsible = false, escalation = true } = {}) {
  const legalCase = await legalCasesService.createLegalCase(
    { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `FS ${uniqueSuffix()}`, responsibleUserId: tenant.userId, escalationUserId: tenant.userId },
    tenant.userId,
    transaction
  );
  const d = await legalDeadlinesService.createLegalDeadline(
    legalCase.id,
    { description: `Critico ${uniqueSuffix()}`, dueAt: FUTURE(), sourceEvent: 'teste', criticality: 'CRITICAL', responsibleUserId },
    tenant.userId,
    transaction
  );
  await legalDeadlinesService.updateLegalDeadline(d.id, { status: 'DONE', conclusionNote: 'Feito.' }, tenant.userId, transaction);
  await LegalCase.update(
    { responsibleUserId: caseResponsible ? tenant.userId : null, ...(escalation ? {} : { escalationUserId: null }) },
    { where: { id: legalCase.id }, transaction }
  );
  return { legalCase, d };
}

async function snapshot(id, transaction) {
  const d = await LegalDeadline.findByPk(id, { transaction });
  const audits = await AuditLog.count({ where: { entityId: id, action: 'legal.deadline.update' }, transaction });
  return { status: d.status, responsibleUserId: d.responsibleUserId, dueAt: new Date(d.dueAt).getTime(), criticality: d.criticality, audits };
}

module.exports = { sequelize, FUTURE, PAST, newUser, concludedCriticalWithoutCaseResponsible, snapshot };
