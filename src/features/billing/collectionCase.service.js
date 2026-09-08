'use strict';

const { CollectionCase } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { evaluateRule } = require('../../engines/rules/rulesEngine');
const billingScheduleService = require('./billingSchedule.service');
const { publishChargeOverdue } = require('./billingEvents.service');

/**
 * openCollectionCase — abre um caso de cobrança para uma competência (billing_schedule) em
 * atraso. Carência (REG-LOC-002) e multa/juros (REG-LOC-001) SEMPRE passam pelo Motor de
 * Regras (fail-closed) — nunca um `if` hardcoded. Se a regra não estiver semeada/publicada
 * para o tenant, evaluateRule retorna DENY e usamos 0 dias de carência / 0% de multa e juros
 * (mais conservador — nunca aplicamos um valor "adivinhado").
 */
async function openCollectionCase(billingScheduleId, daysPastDue, actorUserId, transaction) {
  const billingSchedule = await billingScheduleService.getBillingSchedule(billingScheduleId, transaction);
  if (billingSchedule.status === 'PAID') {
    throw AppError.conflict('Esta competência já está quitada — não há o que cobrar.', 'COLLECTION_CASE_ALREADY_PAID');
  }

  const tenant = { groupId: billingSchedule.groupId, companyId: billingSchedule.companyId };

  const graceEvaluation = await evaluateRule('REG-LOC-002', { gracePeriodRuleActive: true }, tenant, { transaction });
  const graceDays = graceEvaluation.decision === 'APPLY' ? Number(graceEvaluation.action.graceDays || 0) : 0;

  if (daysPastDue < graceDays) {
    throw AppError.conflict(
      `Ainda dentro do período de carência (${graceDays} dias) — competência não está oficialmente em atraso.`,
      'COLLECTION_CASE_WITHIN_GRACE_PERIOD'
    );
  }

  const existing = await CollectionCase.findOne({ where: { billingScheduleId }, transaction });
  if (existing) {
    throw AppError.conflict('Já existe um caso de cobrança aberto para esta competência.', 'COLLECTION_CASE_DUPLICATE');
  }

  const penaltyEvaluation = await evaluateRule('REG-LOC-001', { isOverdue: true }, tenant, { transaction });
  const penaltyPercentage = penaltyEvaluation.decision === 'APPLY' ? Number(penaltyEvaluation.action.penaltyPercentage || 0) : 0;
  const monthlyInterestPercentage = penaltyEvaluation.decision === 'APPLY' ? Number(penaltyEvaluation.action.monthlyInterestPercentage || 0) : 0;

  const balance = Number(billingSchedule.balance);
  const penaltyAmount = round2((balance * penaltyPercentage) / 100);
  // Juros pro rata dia sobre o mês, calculado a partir dos dias em atraso além da carência.
  const overdueDays = daysPastDue - graceDays;
  const interestAmount = round2((balance * (monthlyInterestPercentage / 100) * overdueDays) / 30);

  const originalDebtAmount = balance;
  const currentBalance = round2(originalDebtAmount + penaltyAmount + interestAmount);

  const collectionCase = await CollectionCase.create(
    {
      groupId: billingSchedule.groupId,
      companyId: billingSchedule.companyId,
      billingScheduleId,
      contractId: billingSchedule.contractId,
      status: 'OPEN',
      overdueSince: new Date(Date.now() - daysPastDue * 24 * 60 * 60 * 1000),
      originalDebtAmount,
      currentBalance,
      penaltyAmount,
      interestAmount,
      graceDaysApplied: graceDays,
      penaltyRuleVersionId: penaltyEvaluation.ruleVersionId || null,
      graceRuleVersionId: graceEvaluation.ruleVersionId || null,
      agreementsJson: [],
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishChargeOverdue(collectionCase, transaction);

  await registrarAuditoria(
    {
      groupId: collectionCase.groupId,
      companyId: collectionCase.companyId,
      actorUserId,
      action: 'billing.collection_case.open',
      entityType: 'CollectionCase',
      entityId: collectionCase.id,
      afterJson: collectionCase.toJSON(),
      reason: `Caso de cobrança aberto: dívida original ${originalDebtAmount}, multa ${penaltyAmount}, juros ${interestAmount}.`,
    },
    transaction
  );

  return collectionCase;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

async function getCollectionCase(id, transaction) {
  const collectionCase = await CollectionCase.findByPk(id, { transaction });
  if (!collectionCase) throw AppError.notFound('Caso de cobrança não encontrado.', 'COLLECTION_CASE_NOT_FOUND');
  return collectionCase;
}

async function listCollectionCases(transaction, filters = {}) {
  const where = {};
  if (filters.contractId) where.contractId = filters.contractId;
  if (filters.status) where.status = String(filters.status).toUpperCase();
  return CollectionCase.findAll({ where, order: [['overdue_since', 'ASC']], transaction });
}

/**
 * createAgreement — registra uma NOVA versão de acordo de cobrança. Nunca apaga o histórico:
 * `agreementsJson` é um array append-only (cada chamada adiciona uma entrada nova, versão
 * incremental, sem tocar nas anteriores) — a dívida original (`originalDebtAmount`) também
 * nunca é alterada.
 */
async function createAgreement(collectionCaseId, payload, actorUserId, transaction) {
  const collectionCase = await getCollectionCase(collectionCaseId, transaction);
  if (collectionCase.status === 'RESOLVED') {
    throw AppError.conflict('Caso de cobrança já resolvido — não é possível criar novo acordo.', 'COLLECTION_CASE_ALREADY_RESOLVED');
  }
  const { installments, agreedAmount, notes } = payload;
  if (!installments || !agreedAmount) {
    throw AppError.badRequest('Os campos "installments" e "agreedAmount" são obrigatórios.', 'COLLECTION_AGREEMENT_VALIDATION');
  }
  const beforeJson = collectionCase.toJSON();

  const previousAgreements = Array.isArray(collectionCase.agreementsJson) ? collectionCase.agreementsJson : [];
  const versionNumber = previousAgreements.length + 1;
  const newAgreement = {
    versionNumber,
    installments: Number(installments),
    agreedAmount: Number(agreedAmount),
    notes: notes || null,
    createdBy: actorUserId || null,
    createdAt: new Date().toISOString(),
  };

  collectionCase.agreementsJson = [...previousAgreements, newAgreement];
  collectionCase.currentBalance = Number(agreedAmount);
  collectionCase.status = 'AGREEMENT';
  collectionCase.updatedBy = actorUserId || null;
  await collectionCase.save({ transaction });

  await registrarAuditoria(
    {
      groupId: collectionCase.groupId,
      companyId: collectionCase.companyId,
      actorUserId,
      action: 'billing.collection_case.create_agreement',
      entityType: 'CollectionCase',
      entityId: collectionCase.id,
      beforeJson,
      afterJson: collectionCase.toJSON(),
      reason: `Acordo de cobrança v${versionNumber} criado: ${installments}x, valor acordado ${agreedAmount}.`,
    },
    transaction
  );

  return collectionCase;
}

module.exports = {
  openCollectionCase,
  getCollectionCase,
  listCollectionCases,
  createAgreement,
};
