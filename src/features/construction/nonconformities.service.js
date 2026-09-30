'use strict';

const { Nonconformity } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishNonconformityOpened, publishNonconformityClosed } = require('./constructionEvents.service');

// DECISÃO DE ENGENHARIA (M6-13): severidade fixa em 4 níveis — a fonte pede "severidade" sem
// listar os valores exatos. Segue o mesmo padrão de escala já usado em outros módulos do
// projeto (ex.: risk_level de permissões: LOW/MEDIUM/HIGH + CRITICAL adicionado aqui porque
// M6-25 exige um gate de "NC crítica" para bloquear entrega da obra).
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

async function createNonconformity(projectId, payload, actorUserId, transaction) {
  const {
    groupId,
    companyId,
    projectStageId,
    severity,
    description,
    responsibleUserId,
    slaDueAt,
    beforeEvidenceFileIds,
    requiresAcceptance,
  } = payload;

  if (!groupId || !companyId || !description) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "description" são obrigatórios.', 'NONCONFORMITY_VALIDATION');
  }
  const normalizedSeverity = severity ? String(severity).toUpperCase() : 'MEDIUM';
  if (!SEVERITIES.includes(normalizedSeverity)) {
    throw AppError.badRequest(`"severity" deve ser um de: ${SEVERITIES.join(', ')}.`, 'NONCONFORMITY_SEVERITY_INVALID');
  }

  const nonconformity = await Nonconformity.create(
    {
      groupId,
      companyId,
      projectId,
      projectStageId: projectStageId || null,
      severity: normalizedSeverity,
      description,
      responsibleUserId: responsibleUserId || null,
      slaDueAt: slaDueAt || null,
      status: 'OPEN',
      beforeEvidenceFileIds: Array.isArray(beforeEvidenceFileIds) ? beforeEvidenceFileIds : [],
      afterEvidenceFileIds: [],
      requiresAcceptance: Boolean(requiresAcceptance),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishNonconformityOpened(nonconformity, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.nonconformity.create',
      entityType: 'Nonconformity',
      entityId: nonconformity.id,
      afterJson: nonconformity.toJSON(),
      reason: `NC de severidade "${normalizedSeverity}" aberta para a obra ${projectId}.`,
    },
    transaction
  );

  return nonconformity;
}

async function listNonconformities(projectId, transaction, filters = {}) {
  const where = { projectId };
  if (filters.status) where.status = String(filters.status).toUpperCase();
  return Nonconformity.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getNonconformity(id, transaction) {
  const item = await Nonconformity.findByPk(id, { transaction });
  if (!item) throw AppError.notFound('Não conformidade não encontrada.', 'NONCONFORMITY_NOT_FOUND');
  return item;
}

/**
 * closeNonconformity — REGRA FAIL-CLOSED (M6-24/M6-38/M6-62/M6-86): só fecha se
 * `afterEvidenceFileIds` vier preenchido, e, se `requiresAcceptance=true`, exige
 * `acceptedByUserId` preenchido (no payload OU já preenchido no registro). Nunca fecha
 * silenciosamente — qualquer violação lança AppError e a transação não avança.
 */
async function closeNonconformity(id, payload, actorUserId, transaction) {
  // Lock pessimista: evita duas requisições concorrentes de fechamento lerem o mesmo status
  // OPEN e ambas tentarem fechar/publicar o evento — mesmo padrão de projects.service.js.
  const nonconformity = await Nonconformity.findByPk(id, {
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!nonconformity) throw AppError.notFound('Não conformidade não encontrada.', 'NONCONFORMITY_NOT_FOUND');

  if (nonconformity.status === 'CLOSED') {
    throw AppError.conflict('Não conformidade já está fechada.', 'NONCONFORMITY_ALREADY_CLOSED');
  }

  const { afterEvidenceFileIds, acceptedByUserId } = payload || {};
  const resolvedAfterEvidence = Array.isArray(afterEvidenceFileIds) ? afterEvidenceFileIds : nonconformity.afterEvidenceFileIds;

  if (!Array.isArray(resolvedAfterEvidence) || resolvedAfterEvidence.length === 0) {
    throw AppError.unprocessable(
      'Não é possível fechar a NC sem evidência "depois" ("afterEvidenceFileIds" vazio).',
      'NONCONFORMITY_CLOSE_REQUIRES_AFTER_EVIDENCE'
    );
  }

  const resolvedAcceptedBy = acceptedByUserId !== undefined ? acceptedByUserId : nonconformity.acceptedByUserId;
  if (nonconformity.requiresAcceptance && !resolvedAcceptedBy) {
    throw AppError.unprocessable(
      'Esta NC exige aceite ("requiresAcceptance=true") — "acceptedByUserId" é obrigatório para fechar.',
      'NONCONFORMITY_CLOSE_REQUIRES_ACCEPTANCE'
    );
  }

  const beforeJson = nonconformity.toJSON();
  nonconformity.afterEvidenceFileIds = resolvedAfterEvidence;
  if (resolvedAcceptedBy) nonconformity.acceptedByUserId = resolvedAcceptedBy;
  nonconformity.status = 'CLOSED';
  nonconformity.closedAt = new Date();
  nonconformity.updatedBy = actorUserId || null;
  await nonconformity.save({ transaction });

  await publishNonconformityClosed(nonconformity, transaction);

  await registrarAuditoria(
    {
      groupId: nonconformity.groupId,
      companyId: nonconformity.companyId,
      actorUserId,
      action: 'construction.nonconformity.close',
      entityType: 'Nonconformity',
      entityId: nonconformity.id,
      beforeJson,
      afterJson: nonconformity.toJSON(),
      reason: `NC fechada com evidência "depois" (${resolvedAfterEvidence.length} arquivo(s)).`,
    },
    transaction
  );

  return nonconformity;
}

module.exports = { createNonconformity, listNonconformities, getNonconformity, closeNonconformity, SEVERITIES };
