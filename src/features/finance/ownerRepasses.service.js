'use strict';

const { OwnerRepass } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { assertBankAccountEligibleForPayment, assertNoDuplicatePayment } = require('./financeAntifraud.service');
const { publishOwnerRepasseCreated } = require('./financeEvents.service');

const STATUSES = ['PENDING', 'PAID', 'CANCELLED'];

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * createOwnerRepasse — calcula netAmount = grossAmount - deductionsAmount (nunca confia em um
 * netAmount enviado pelo cliente — sempre recalcula server-side, pra não abrir brecha de
 * manipular o valor líquido repassado ao proprietário). `idempotencyKey` evita repasse
 * duplicado do mesmo mês/imóvel se o processo rodar duas vezes.
 */
async function createOwnerRepasse(payload, actorUserId, transaction) {
  const { groupId, companyId, propertyId, ownerPersonId, contractId, bankAccountId, grossAmount, deductionsAmount, referenceMonth, idempotencyKey } = payload;

  if (!groupId || !companyId || !propertyId || !ownerPersonId || grossAmount === undefined) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "propertyId", "ownerPersonId" e "grossAmount" são obrigatórios.',
      'FINANCE_OWNER_REPASSE_VALIDATION'
    );
  }
  const grossNumeric = Number(grossAmount);
  const deductionsNumeric = Number(deductionsAmount) || 0;
  if (!Number.isFinite(grossNumeric) || grossNumeric <= 0) {
    throw AppError.badRequest('O campo "grossAmount" deve ser um número positivo.', 'FINANCE_OWNER_REPASSE_VALIDATION');
  }
  if (deductionsNumeric < 0 || deductionsNumeric > grossNumeric) {
    throw AppError.badRequest('O campo "deductionsAmount" não pode ser negativo nem maior que "grossAmount".', 'FINANCE_OWNER_REPASSE_VALIDATION');
  }
  if (referenceMonth && !/^\d{4}-\d{2}$/.test(referenceMonth)) {
    throw AppError.badRequest('O campo "referenceMonth" deve estar no formato "YYYY-MM".', 'FINANCE_OWNER_REPASSE_VALIDATION');
  }

  await assertNoDuplicatePayment(OwnerRepass, idempotencyKey, transaction);

  const netAmount = round2(grossNumeric - deductionsNumeric);

  const repasse = await OwnerRepass.create(
    {
      groupId,
      companyId,
      propertyId,
      ownerPersonId,
      contractId: contractId || null,
      bankAccountId: bankAccountId || null,
      grossAmount: grossNumeric,
      deductionsAmount: deductionsNumeric,
      netAmount,
      referenceMonth: referenceMonth || null,
      status: 'PENDING',
      idempotencyKey: idempotencyKey || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishOwnerRepasseCreated(repasse, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.owner_repasse.create',
      entityType: 'OwnerRepass',
      entityId: repasse.id,
      afterJson: repasse.toJSON(),
      reason: `Repasse de ${netAmount} (bruto ${grossNumeric} - deduções ${deductionsNumeric}) registrado.`,
    },
    transaction
  );

  return repasse;
}

async function listOwnerRepasses(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.ownerPersonId) where.ownerPersonId = filters.ownerPersonId;
  if (filters.propertyId) where.propertyId = filters.propertyId;
  return OwnerRepass.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getOwnerRepasse(id, transaction) {
  const repasse = await OwnerRepass.findByPk(id, { transaction });
  if (!repasse) throw AppError.notFound('Repasse não encontrado.', 'FINANCE_OWNER_REPASSE_NOT_FOUND');
  return repasse;
}

/**
 * payOwnerRepasse — efetiva o pagamento do repasse. Passa pela MESMA checagem de elegibilidade
 * antifraude da conta bancária (cooldown/bloqueio) usada em financialEntries.settleFinancialEntry.
 */
async function payOwnerRepasse(id, actorUserId, transaction) {
  const repasse = await getOwnerRepasse(id, transaction);
  if (repasse.status !== 'PENDING') {
    throw AppError.conflict(`Só é possível pagar um repasse PENDING (atual: "${repasse.status}").`, 'FINANCE_OWNER_REPASSE_INVALID_STATUS');
  }
  const beforeJson = repasse.toJSON();

  if (repasse.bankAccountId) {
    await assertBankAccountEligibleForPayment(repasse.bankAccountId, transaction);
  }

  repasse.status = 'PAID';
  repasse.updatedBy = actorUserId || null;
  await repasse.save({ transaction });

  await registrarAuditoria(
    {
      groupId: repasse.groupId,
      companyId: repasse.companyId,
      actorUserId,
      action: 'finance.owner_repasse.pay',
      entityType: 'OwnerRepass',
      entityId: repasse.id,
      beforeJson,
      afterJson: repasse.toJSON(),
      reason: `Repasse de ${repasse.netAmount} pago ao proprietário.`,
    },
    transaction
  );

  return repasse;
}

module.exports = { createOwnerRepasse, listOwnerRepasses, getOwnerRepasse, payOwnerRepasse, STATUSES };
