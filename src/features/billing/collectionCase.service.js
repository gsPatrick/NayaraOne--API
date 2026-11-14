'use strict';

const { CollectionCase, BillingSchedule } = require('../../models');
const AppError = require('../../utils/AppError');
const { assertUuid, assertText } = require('../../utils/inputGuards');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { evaluateRule } = require('../../engines/rules/rulesEngine');
const billingScheduleService = require('./billingSchedule.service');
const { publishChargeOverdue } = require('./billingEvents.service');
const { syncPenaltyRulesFromSettings } = require('./penaltyRules.service');

// Número da ação da regra (ausente ou inválido = 0, fail closed).
const ruleNumber = (action, field) => (Number.isFinite(Number(action && action[field])) ? Number(action[field]) : 0);

/**
 * openCollectionCase — abre um caso de cobrança para uma competência (billing_schedule) em
 * atraso. Carência (REG-LOC-002) e multa/juros (REG-LOC-001) SEMPRE passam pelo Motor de
 * Regras (fail-closed) — nunca um `if` hardcoded. Se a regra não estiver semeada/publicada
 * para o tenant, evaluateRule retorna DENY e usamos 0 dias de carência / 0% de multa e juros
 * (mais conservador — nunca aplicamos um valor "adivinhado").
 *
 * Fechamento M5 (M5-A0330, livro "Multa/juros/grace/cadência via Motor de Regras"): os percentuais e a carência vêm SÓ da
 * ação da versão vigente das regras (REG-LOC-001 penaltyPercentage/monthlyInterestPercentage, REG-LOC-002 graceDays); não há
 * número de reserva no código. Os números que o administrador grava na aba Cobrança viram versões novas dessas regras
 * (penaltyRules.service.js), e o caso grava a versão usada (penalty_rule_version_id / grace_rule_version_id).
 */
async function openCollectionCase(billingScheduleId, daysPastDue, actorUserId, transaction) {
  // FIX (concorrência): sem lock pessimista aqui, duas chamadas concorrentes de
  // openCollectionCase para a mesma competência liam o "findOne" abaixo antes de qualquer uma
  // delas ter criado a linha e as duas passavam pela checagem de duplicidade, criando DOIS
  // CollectionCase para a mesma billing_schedule (nenhuma constraint única em
  // billing_schedule_id). Lock pego numa consulta separada, sem include, pelo mesmo motivo já
  // documentado em billingSchedule.service.js#registerPayment: `SELECT ... FOR UPDATE` não é
  // compatível com o LEFT JOIN de `items` que getBillingSchedule usa. Travar a linha de
  // billing_schedule serializa as duas chamadas concorrentes: a segunda só prossegue depois da
  // primeira commitar, e aí enxerga o CollectionCase já criado pela primeira.
  // Fechamento M5 (pentest): id e dias com tipo errado viram 400, nunca 500.
  assertUuid(billingScheduleId, 'billingScheduleId', 'COLLECTION_CASE_VALIDATION');
  if (!Number.isFinite(daysPastDue) || daysPastDue < 0) throw AppError.badRequest('"daysPastDue" deve ser um número de dias maior ou igual a zero.', 'COLLECTION_CASE_VALIDATION');
  await BillingSchedule.findByPk(billingScheduleId, { transaction, lock: transaction.LOCK.UPDATE });

  const billingSchedule = await billingScheduleService.getBillingSchedule(billingScheduleId, transaction);
  if (billingSchedule.status === 'PAID') {
    throw AppError.conflict('Esta competência já está quitada — não há o que cobrar.', 'COLLECTION_CASE_ALREADY_PAID');
  }

  const tenant = { groupId: billingSchedule.groupId, companyId: billingSchedule.companyId };

  // Empresa que já tinha números gravados na configuração antes desta mudança: a regra é alinhada a eles (publicação auditada).
  await syncPenaltyRulesFromSettings(tenant, actorUserId, transaction);
  const graceEvaluation = await evaluateRule('REG-LOC-002', { gracePeriodRuleActive: true }, tenant, { transaction });
  const graceDays = graceEvaluation.decision === 'APPLY' ? ruleNumber(graceEvaluation.action, 'graceDays') : 0;

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
  const penaltyPercentage = penaltyEvaluation.decision === 'APPLY' ? ruleNumber(penaltyEvaluation.action, 'penaltyPercentage') : 0;
  const monthlyInterestPercentage = penaltyEvaluation.decision === 'APPLY' ? ruleNumber(penaltyEvaluation.action, 'monthlyInterestPercentage') : 0;

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
  if (!Number.isInteger(Number(installments)) || Number(installments) <= 0 || typeof installments === 'object' || typeof agreedAmount === 'object' || !Number.isFinite(Number(agreedAmount)) || Number(agreedAmount) <= 0) {
    throw AppError.badRequest('"installments" deve ser um inteiro positivo e "agreedAmount" um valor maior que zero.', 'COLLECTION_AGREEMENT_VALIDATION');
  }
  assertText(notes, 'notes', 2000, 'COLLECTION_AGREEMENT_VALIDATION');
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
