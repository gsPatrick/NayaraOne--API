'use strict';

const { AnomalyCase } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/**
 * anomalyCases.service.js — GAP REAL CORRIGIDO (Caderno §5/§17/§19). Antes, todo achado de
 * antifraude ficava só como uma flag booleana (`requires_manual_review`) no próprio registro
 * afetado, sem nenhum histórico próprio nem forma de contar/listar "quantos casos HIGH/CRITICAL
 * estão abertos agora" — que é exatamente o indicador "Anomalias" do relatório semanal de saúde
 * (§19) e o requisito "Estorno frequente → Anomaly case" da tabela de antifraude (§17).
 */
async function createAnomalyCase(payload, actorUserId, transaction) {
  const { groupId, companyId, caseType, riskLevel, relatedEntityType, relatedEntityId, reason } = payload;
  if (!groupId || !companyId || !caseType || !riskLevel || !reason) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "caseType", "riskLevel" e "reason" são obrigatórios.',
      'FINANCE_ANOMALY_CASE_VALIDATION'
    );
  }
  const normalizedRisk = String(riskLevel).toUpperCase();
  if (!RISK_LEVELS.includes(normalizedRisk)) {
    throw AppError.badRequest(`O campo "riskLevel" deve ser um de: ${RISK_LEVELS.join(', ')}.`, 'FINANCE_ANOMALY_CASE_VALIDATION');
  }

  const anomalyCase = await AnomalyCase.create(
    {
      groupId,
      companyId,
      caseType: String(caseType).toUpperCase(),
      riskLevel: normalizedRisk,
      relatedEntityType: relatedEntityType || null,
      relatedEntityId: relatedEntityId || null,
      reason,
      status: 'OPEN',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.anomaly_case.create',
      entityType: 'AnomalyCase',
      entityId: anomalyCase.id,
      afterJson: anomalyCase.toJSON(),
      reason: `Caso de anomalia aberto (${normalizedRisk}): ${reason}`,
    },
    transaction
  );

  return anomalyCase;
}

async function listAnomalyCases(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.riskLevel) where.riskLevel = String(filters.riskLevel).toUpperCase();
  return AnomalyCase.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function countOpenHighRiskAnomalies(companyId, transaction) {
  const { Op } = require('sequelize');
  return AnomalyCase.count({
    where: { companyId, status: 'OPEN', riskLevel: { [Op.in]: ['HIGH', 'CRITICAL'] } },
    transaction,
  });
}

async function resolveAnomalyCase(id, actorUserId, transaction, resolutionNote) {
  const anomalyCase = await AnomalyCase.findByPk(id, { transaction });
  if (!anomalyCase) throw AppError.notFound('Caso de anomalia não encontrado.', 'FINANCE_ANOMALY_CASE_NOT_FOUND');
  if (anomalyCase.status === 'RESOLVED') {
    throw AppError.conflict('Este caso de anomalia já está resolvido.', 'FINANCE_ANOMALY_CASE_ALREADY_RESOLVED');
  }
  const beforeJson = anomalyCase.toJSON();
  anomalyCase.status = 'RESOLVED';
  anomalyCase.resolvedAt = new Date();
  anomalyCase.resolvedBy = actorUserId || null;
  anomalyCase.resolutionNote = resolutionNote || null;
  anomalyCase.updatedBy = actorUserId || null;
  await anomalyCase.save({ transaction });

  await registrarAuditoria(
    {
      groupId: anomalyCase.groupId,
      companyId: anomalyCase.companyId,
      actorUserId,
      action: 'finance.anomaly_case.resolve',
      entityType: 'AnomalyCase',
      entityId: anomalyCase.id,
      beforeJson,
      afterJson: anomalyCase.toJSON(),
      reason: resolutionNote || 'Caso de anomalia resolvido.',
    },
    transaction
  );

  return anomalyCase;
}

module.exports = {
  createAnomalyCase,
  listAnomalyCases,
  countOpenHighRiskAnomalies,
  resolveAnomalyCase,
  RISK_LEVELS,
};
