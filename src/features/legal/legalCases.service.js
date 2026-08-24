'use strict';

const { LegalCase, Task } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishLegalCaseCreated } = require('./legalEvents.service');

const CASE_TYPES = ['LITIGATION', 'CONSULTATIVE', 'COLLECTION'];

async function createLegalCase(payload, actorUserId, transaction) {
  const { groupId, companyId, contractId, propertyId, responsibleUserId, caseNumber, caseType, summary } = payload;
  if (!groupId || !companyId || !caseType) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "caseType" são obrigatórios.', 'LEGAL_CASE_VALIDATION');
  }
  if (!CASE_TYPES.includes(caseType)) {
    throw AppError.badRequest(`"caseType" deve ser um de: ${CASE_TYPES.join(', ')}.`, 'LEGAL_CASE_VALIDATION');
  }

  const legalCase = await LegalCase.create(
    {
      groupId,
      companyId,
      contractId: contractId || null,
      propertyId: propertyId || null,
      responsibleUserId: responsibleUserId || null,
      caseNumber: caseNumber || null,
      caseType,
      status: 'OPEN',
      summary: summary || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishLegalCaseCreated(legalCase, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'legal.case.create',
      entityType: 'LegalCase',
      entityId: legalCase.id,
      afterJson: legalCase.toJSON(),
      reason: `Processo jurídico "${caseType}" aberto.`,
    },
    transaction
  );

  return legalCase;
}

async function listLegalCases(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.caseType) where.caseType = String(filters.caseType).toUpperCase();
  if (filters.contractId) where.contractId = filters.contractId;
  return LegalCase.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getLegalCase(id, transaction) {
  const legalCase = await LegalCase.findByPk(id, { transaction });
  if (!legalCase) throw AppError.notFound('Processo jurídico não encontrado.', 'LEGAL_CASE_NOT_FOUND');
  return legalCase;
}

async function updateLegalCase(id, payload, actorUserId, transaction) {
  const legalCase = await getLegalCase(id, transaction);
  const beforeJson = legalCase.toJSON();
  const { status, summary, responsibleUserId } = payload;
  if (status !== undefined) legalCase.status = status;
  if (summary !== undefined) legalCase.summary = summary;
  if (responsibleUserId !== undefined) legalCase.responsibleUserId = responsibleUserId;
  legalCase.updatedBy = actorUserId || null;
  await legalCase.save({ transaction });

  await registrarAuditoria(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      actorUserId,
      action: 'legal.case.update',
      entityType: 'LegalCase',
      entityId: legalCase.id,
      beforeJson,
      afterJson: legalCase.toJSON(),
      reason: `Processo jurídico ${legalCase.id} atualizado.`,
    },
    transaction
  );

  return legalCase;
}

/**
 * linkCaseToTask — DECISÃO DE ENGENHARIA: o doc pede para verificar se existe uma
 * tabela/model de tasks vinculável antes de inventar mecanismo. Existe `Task` (core.tasks,
 * src/models/Task.js) com colunas polimórficas `related_entity_type` + `related_entity_id`
 * — o MESMO padrão já usado por finance.approval_requests (ver
 * src/features/finance/approvals.service.js). Reutilizamos esse mecanismo existente: vincular
 * uma task a um processo jurídico é simplesmente setar `relatedEntityType: 'LegalCase'` e
 * `relatedEntityId: legalCaseId` na Task — sem precisar de tabela nova nem de migration.
 * `core.tasks` não tem FK real para legal.legal_cases (é polimórfico, `constraints: false`,
 * igual às demais associações desse tipo no projeto), então a integridade referencial aqui é
 * responsabilidade da aplicação, não do banco — mesmo trade-off já aceito em approvals.
 */
async function linkCaseToTask(legalCaseId, taskId, actorUserId, transaction) {
  const legalCase = await getLegalCase(legalCaseId, transaction);
  const task = await Task.findByPk(taskId, { transaction });
  if (!task) throw AppError.notFound('Tarefa não encontrada.', 'LEGAL_CASE_TASK_NOT_FOUND');

  const beforeJson = task.toJSON();
  task.relatedEntityType = 'LegalCase';
  task.relatedEntityId = legalCase.id;
  task.updatedBy = actorUserId || null;
  await task.save({ transaction });

  await registrarAuditoria(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      actorUserId,
      action: 'legal.case.link_task',
      entityType: 'Task',
      entityId: task.id,
      beforeJson,
      afterJson: task.toJSON(),
      reason: `Tarefa ${task.id} vinculada ao processo jurídico ${legalCase.id}.`,
    },
    transaction
  );

  return task;
}

module.exports = { createLegalCase, listLegalCases, getLegalCase, updateLegalCase, linkCaseToTask, CASE_TYPES };
