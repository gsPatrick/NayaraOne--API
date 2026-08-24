'use strict';

const { Guarantee } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishGuaranteeCreated } = require('./legalEvents.service');
const { getContract } = require('./contracts.service');

const GUARANTEE_TYPES = ['GUARANTOR', 'INSURANCE', 'DEPOSIT', 'CAPITALIZATION_TITLE'];

async function createGuarantee(contractId, payload, actorUserId, transaction) {
  const contract = await getContract(contractId, transaction);
  const { guaranteeType, guarantorPersonId, value, status, startsAt, endsAt } = payload;

  if (!guaranteeType) {
    throw AppError.badRequest('O campo "guaranteeType" é obrigatório.', 'LEGAL_GUARANTEE_VALIDATION');
  }
  if (!GUARANTEE_TYPES.includes(guaranteeType)) {
    throw AppError.badRequest(`"guaranteeType" deve ser um de: ${GUARANTEE_TYPES.join(', ')}.`, 'LEGAL_GUARANTEE_VALIDATION');
  }
  if (guaranteeType === 'GUARANTOR' && !guarantorPersonId) {
    throw AppError.badRequest('"guarantorPersonId" é obrigatório quando "guaranteeType" é "GUARANTOR".', 'LEGAL_GUARANTEE_VALIDATION');
  }

  const guarantee = await Guarantee.create(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      contractId: contract.id,
      guaranteeType,
      guarantorPersonId: guaranteeType === 'GUARANTOR' ? guarantorPersonId : (guarantorPersonId || null),
      value: value !== undefined ? value : null,
      status: status || 'ACTIVE',
      startsAt: startsAt || null,
      endsAt: endsAt || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishGuaranteeCreated(guarantee, transaction);

  await registrarAuditoria(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      actorUserId,
      action: 'legal.guarantee.create',
      entityType: 'Guarantee',
      entityId: guarantee.id,
      afterJson: guarantee.toJSON(),
      reason: `Garantia "${guaranteeType}" criada para o contrato ${contract.id}.`,
    },
    transaction
  );

  return guarantee;
}

async function listGuarantees(transaction, filters = {}) {
  const where = {};
  if (filters.contractId) where.contractId = filters.contractId;
  if (filters.status) where.status = String(filters.status).toUpperCase();
  return Guarantee.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getGuarantee(id, transaction) {
  const guarantee = await Guarantee.findByPk(id, { transaction });
  if (!guarantee) throw AppError.notFound('Garantia não encontrada.', 'LEGAL_GUARANTEE_NOT_FOUND');
  return guarantee;
}

async function updateGuarantee(id, payload, actorUserId, transaction) {
  const guarantee = await getGuarantee(id, transaction);
  const beforeJson = guarantee.toJSON();
  const { status, startsAt, endsAt, value } = payload;
  if (status !== undefined) guarantee.status = status;
  if (startsAt !== undefined) guarantee.startsAt = startsAt;
  if (endsAt !== undefined) guarantee.endsAt = endsAt;
  if (value !== undefined) guarantee.value = value;
  guarantee.updatedBy = actorUserId || null;
  await guarantee.save({ transaction });

  await registrarAuditoria(
    {
      groupId: guarantee.groupId,
      companyId: guarantee.companyId,
      actorUserId,
      action: 'legal.guarantee.update',
      entityType: 'Guarantee',
      entityId: guarantee.id,
      beforeJson,
      afterJson: guarantee.toJSON(),
      reason: `Garantia ${guarantee.id} atualizada.`,
    },
    transaction
  );

  return guarantee;
}

async function deleteGuarantee(id, actorUserId, transaction) {
  const guarantee = await getGuarantee(id, transaction);
  const beforeJson = guarantee.toJSON();
  guarantee.deletedBy = actorUserId || null;
  await guarantee.save({ transaction });
  await guarantee.destroy({ transaction });

  await registrarAuditoria(
    {
      groupId: guarantee.groupId,
      companyId: guarantee.companyId,
      actorUserId,
      action: 'legal.guarantee.delete',
      entityType: 'Guarantee',
      entityId: guarantee.id,
      beforeJson,
      reason: `Garantia ${guarantee.id} excluída (soft delete).`,
    },
    transaction
  );

  return { id };
}

module.exports = { createGuarantee, listGuarantees, getGuarantee, updateGuarantee, deleteGuarantee, GUARANTEE_TYPES };
