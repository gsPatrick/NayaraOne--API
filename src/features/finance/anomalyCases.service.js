'use strict';

const { AnomalyCase, User, FinancialEntry, PaymentIntent } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishAnomalyOpened } = require('./financeEvents.service');

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
  await publishAnomalyOpened(anomalyCase, transaction);

  return anomalyCase;
}

// Título em português por tipo de caso (R7). Tipo desconhecido nunca vira texto técnico: cai
// num rótulo neutro mas honesto.
const CASE_TYPE_TITLES = {
  AMOUNT_OUTLIER: 'Valor fora do padrão',
  FREQUENT_REVERSAL: 'Estornos frequentes',
  DUPLICATE_SETTLEMENT: 'Possível pagamento em dobro',
  BENEFICIARY_CHANGED: 'Conta bancária do favorecido trocada',
  LATE_BANK_CONFIRMATION: 'Confirmação do banco após falha',
  BANK_PAYMENT_RETURNED: 'Pagamento devolvido pelo banco',
  BANK_CONFIRMATION_UNDER_REVIEW: 'Confirmação do banco em revisão manual',
  POST_CLOSING_BANK_CONFIRMATION: 'Confirmação do banco após o fechamento',
  BANK_UNREACHABLE: 'Banco indisponível no envio',
};

function caseTypeTitle(caseType) {
  return CASE_TYPE_TITLES[caseType] || 'Alerta financeiro (tipo não catalogado)';
}

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Serializa o caso para a tela: data de abertura (created_at underscored — o model expõe o
 * atributo como `created_at`, não `createdAt`), quem resolveu, o lançamento relacionado e o
 * título em português.
 */
async function serializeAnomalyCases(cases, transaction) {
  const rows = Array.isArray(cases) ? cases : [cases];
  const userIds = [...new Set(rows.flatMap((c) => [c.resolvedBy, c.createdBy]).filter(Boolean))];
  const users = userIds.length ? await User.findAll({ where: { id: userIds }, attributes: ['id', 'name'], transaction }) : [];
  const userName = new Map(users.map((u) => [u.id, u.name]));

  const entryIds = new Set();
  const intentIds = [];
  for (const c of rows) {
    if (c.relatedEntityType === 'FinancialEntry' && c.relatedEntityId) entryIds.add(c.relatedEntityId);
    if (c.relatedEntityType === 'PaymentIntent' && c.relatedEntityId) intentIds.push(c.relatedEntityId);
  }
  const intents = intentIds.length ? await PaymentIntent.findAll({ where: { id: intentIds }, transaction }) : [];
  const intentToEntry = new Map(intents.map((i) => [i.id, i.financialEntryId]));
  for (const entryId of intentToEntry.values()) if (entryId) entryIds.add(entryId);
  const entries = entryIds.size ? await FinancialEntry.findAll({ where: { id: [...entryIds] }, transaction }) : [];
  const entryById = new Map(entries.map((e) => [e.id, e]));

  const out = rows.map((c) => {
    const json = c.toJSON();
    const createdAt = toIso(c.get('created_at') || c.get('createdAt') || json.created_at || json.createdAt);
    const updatedAt = toIso(c.get('updated_at') || c.get('updatedAt') || json.updated_at || json.updatedAt);
    const entryId = c.relatedEntityType === 'PaymentIntent' ? intentToEntry.get(c.relatedEntityId) : c.relatedEntityId;
    const entry = entryId ? entryById.get(entryId) : null;
    return {
      ...json,
      createdAt,
      updatedAt,
      caseTypeLabel: caseTypeTitle(c.caseType),
      resolvedAt: toIso(c.resolvedAt),
      resolvedByName: c.resolvedBy ? userName.get(c.resolvedBy) || null : null,
      relatedEntry: entry
        ? { id: entry.id, description: entry.description, amount: entry.amount, status: entry.status }
        : null,
    };
  });
  return Array.isArray(cases) ? out : out[0];
}

async function listAnomalyCases(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.riskLevel) where.riskLevel = String(filters.riskLevel).toUpperCase();
  const cases = await AnomalyCase.findAll({ where, order: [['created_at', 'DESC']], transaction });
  return serializeAnomalyCases(cases, transaction);
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

  return serializeAnomalyCases(anomalyCase, transaction);
}

module.exports = {
  createAnomalyCase,
  listAnomalyCases,
  countOpenHighRiskAnomalies,
  resolveAnomalyCase,
  serializeAnomalyCases,
  caseTypeTitle,
  CASE_TYPE_TITLES,
  RISK_LEVELS,
};
