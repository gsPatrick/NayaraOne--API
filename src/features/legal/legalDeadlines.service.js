'use strict';

const { LegalDeadline } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { getLegalCase } = require('./legalCases.service');

/**
 * computeSeverity — DECISÃO DE ENGENHARIA: severidade não é uma coluna persistida (o doc só
 * define due_at + status na tabela) — é calculada em runtime a partir de due_at/status, para
 * listagem/priorização, seguindo o exemplo dado no doc ("OVERDUE se due_at no passado e
 * status PENDING"). Além de OVERDUE, adicionamos DUE_SOON (próximas 48h) e NORMAL como
 * granularidade extra útil pra UI de prazos — não pedida explicitamente, mas consistente com
 * o único caso citado no doc.
 */
function computeSeverity(deadline, now = new Date()) {
  if (deadline.status !== 'PENDING') return 'DONE';
  const dueAt = new Date(deadline.dueAt);
  if (dueAt.getTime() < now.getTime()) return 'OVERDUE';
  const hoursUntilDue = (dueAt.getTime() - now.getTime()) / (1000 * 60 * 60);
  if (hoursUntilDue <= 48) return 'DUE_SOON';
  return 'NORMAL';
}

async function createLegalDeadline(legalCaseId, payload, actorUserId, transaction) {
  const legalCase = await getLegalCase(legalCaseId, transaction);
  const { description, dueAt } = payload;
  if (!description || !dueAt) {
    throw AppError.badRequest('Os campos "description" e "dueAt" são obrigatórios.', 'LEGAL_DEADLINE_VALIDATION');
  }

  const deadline = await LegalDeadline.create(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      legalCaseId: legalCase.id,
      description,
      dueAt,
      status: 'PENDING',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      actorUserId,
      action: 'legal.deadline.create',
      entityType: 'LegalDeadline',
      entityId: deadline.id,
      afterJson: deadline.toJSON(),
      reason: `Prazo "${description}" criado para o processo ${legalCase.id}.`,
    },
    transaction
  );

  return deadline;
}

async function listLegalDeadlines(transaction, filters = {}) {
  const where = {};
  if (filters.legalCaseId) where.legalCaseId = filters.legalCaseId;
  if (filters.status) where.status = String(filters.status).toUpperCase();

  const deadlines = await LegalDeadline.findAll({ where, order: [['due_at', 'ASC']], transaction });
  const now = new Date();
  const withSeverity = deadlines.map((d) => {
    const json = d.toJSON();
    json.severity = computeSeverity(d, now);
    return json;
  });

  if (filters.severity) {
    return withSeverity.filter((d) => d.severity === String(filters.severity).toUpperCase());
  }
  return withSeverity;
}

async function getLegalDeadline(id, transaction) {
  const deadline = await LegalDeadline.findByPk(id, { transaction });
  if (!deadline) throw AppError.notFound('Prazo jurídico não encontrado.', 'LEGAL_DEADLINE_NOT_FOUND');
  return deadline;
}

async function updateLegalDeadline(id, payload, actorUserId, transaction) {
  const deadline = await getLegalDeadline(id, transaction);
  const beforeJson = deadline.toJSON();
  const { status, description, dueAt } = payload;
  if (status !== undefined) deadline.status = status;
  if (description !== undefined) deadline.description = description;
  if (dueAt !== undefined) deadline.dueAt = dueAt;
  deadline.updatedBy = actorUserId || null;
  await deadline.save({ transaction });

  await registrarAuditoria(
    {
      groupId: deadline.groupId,
      companyId: deadline.companyId,
      actorUserId,
      action: 'legal.deadline.update',
      entityType: 'LegalDeadline',
      entityId: deadline.id,
      beforeJson,
      afterJson: deadline.toJSON(),
      reason: `Prazo ${deadline.id} atualizado.`,
    },
    transaction
  );

  return deadline;
}

module.exports = { createLegalDeadline, listLegalDeadlines, getLegalDeadline, updateLegalDeadline, computeSeverity };
