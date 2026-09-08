'use strict';

const { RentAdjustment, Contract } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishRentAdjusted } = require('./billingEvents.service');
const { unavailableIndexSourceAdapter } = require('./adapters/IndexSourceAdapter');

const PERIOD_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * requestRentAdjustment — solicita/aplica um reajuste de aluguel para um contrato numa
 * competência de índice. Consulta o adapter de fonte de índice (`indexSourceAdapter`,
 * injetável para testes — default é `unavailableIndexSourceAdapter`, que sempre responde
 * indisponível).
 *
 * Se a fonte não tiver o índice disponível: grava o registro com status PENDING_SOURCE,
 * `rawIndexValue`/`newRentAmount` NULL — NUNCA inventa um percentual. Se disponível, aplica o
 * percentual "raw" fornecido pela fonte como "applied" por padrão, salvo se o chamador
 * informar `appliedPercentageOverride` (negociação manual) — `applied` pode divergir de `raw`
 * por decisão comercial, mas nunca é gerado sozinho quando `raw` está ausente.
 */
async function requestRentAdjustment(payload, actorUserId, transaction, indexSourceAdapter = unavailableIndexSourceAdapter) {
  const { groupId, companyId, contractId, indexCode, period, oldRentAmount, appliedPercentageOverride } = payload;

  if (!groupId || !companyId || !contractId || !indexCode || oldRentAmount === undefined || oldRentAmount === null) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "contractId", "indexCode" e "oldRentAmount" são obrigatórios.',
      'RENT_ADJUSTMENT_VALIDATION'
    );
  }
  if (!period || !PERIOD_REGEX.test(period)) {
    throw AppError.badRequest('O campo "period" deve estar no formato "YYYY-MM".', 'RENT_ADJUSTMENT_VALIDATION');
  }

  const contract = await Contract.findByPk(contractId, { transaction });
  if (!contract) {
    throw AppError.notFound('Contrato não encontrado.', 'RENT_ADJUSTMENT_CONTRACT_NOT_FOUND');
  }

  const existing = await RentAdjustment.findOne({ where: { contractId, period }, transaction });
  if (existing) {
    throw AppError.conflict(
      `Já existe reajuste registrado para o contrato ${contractId} na competência "${period}".`,
      'RENT_ADJUSTMENT_DUPLICATE_PERIOD'
    );
  }

  const indexResult = await indexSourceAdapter.getIndex(indexCode, period);

  if (!indexResult || !indexResult.available) {
    const rentAdjustment = await RentAdjustment.create(
      {
        groupId,
        companyId,
        contractId,
        indexCode,
        period,
        rawIndexValue: null,
        appliedPercentage: null,
        oldRentAmount,
        newRentAmount: null,
        ruleVersionId: null,
        status: 'PENDING_SOURCE',
        appliedAt: null,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );

    await publishRentAdjusted(rentAdjustment, transaction);

    await registrarAuditoria(
      {
        groupId,
        companyId,
        actorUserId,
        action: 'billing.rent_adjustment.pending_source',
        entityType: 'RentAdjustment',
        entityId: rentAdjustment.id,
        afterJson: rentAdjustment.toJSON(),
        reason: `Índice "${indexCode}" indisponível para a competência "${period}" — reajuste marcado como PENDING_SOURCE, nenhum percentual foi inventado.`,
      },
      transaction
    );

    return rentAdjustment;
  }

  const rawIndexValue = Number(indexResult.rawValue);
  const appliedPercentage = appliedPercentageOverride !== undefined && appliedPercentageOverride !== null
    ? Number(appliedPercentageOverride)
    : rawIndexValue;
  const newRentAmount = Math.round(Number(oldRentAmount) * (1 + appliedPercentage / 100) * 100) / 100;

  const rentAdjustment = await RentAdjustment.create(
    {
      groupId,
      companyId,
      contractId,
      indexCode,
      period,
      rawIndexValue,
      appliedPercentage,
      oldRentAmount,
      newRentAmount,
      ruleVersionId: null,
      status: 'APPLIED',
      appliedAt: new Date(),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishRentAdjusted(rentAdjustment, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'billing.rent_adjustment.apply',
      entityType: 'RentAdjustment',
      entityId: rentAdjustment.id,
      afterJson: rentAdjustment.toJSON(),
      reason: `Reajuste aplicado: índice "${indexCode}" (${rawIndexValue}%), percentual aplicado ${appliedPercentage}%, aluguel ${oldRentAmount} -> ${newRentAmount}.`,
    },
    transaction
  );

  return rentAdjustment;
}

async function getRentAdjustment(id, transaction) {
  const rentAdjustment = await RentAdjustment.findByPk(id, { transaction });
  if (!rentAdjustment) throw AppError.notFound('Reajuste não encontrado.', 'RENT_ADJUSTMENT_NOT_FOUND');
  return rentAdjustment;
}

async function listRentAdjustments(transaction, filters = {}) {
  const where = {};
  if (filters.contractId) where.contractId = filters.contractId;
  if (filters.status) where.status = String(filters.status).toUpperCase();
  return RentAdjustment.findAll({ where, order: [['period', 'DESC']], transaction });
}

module.exports = {
  requestRentAdjustment,
  getRentAdjustment,
  listRentAdjustments,
};
