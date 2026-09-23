'use strict';

const { Guarantee } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishGuaranteeCreated } = require('./legalEvents.service');
const { getContract } = require('./contracts.service');

const GUARANTEE_TYPES = ['GUARANTOR', 'INSURANCE', 'DEPOSIT', 'CAPITALIZATION_TITLE'];
// FIX (homologação 22/09/2026 — auditoria proativa): `status` era gravado como string livre
// (sem ENUM/CHECK no model nem validação aqui), apesar de contracts.service.js/
// assertActivationGate depender literalmente da string 'ACTIVE' pra decidir se a garantia conta
// como ativa na ativação do contrato. Um typo (`"Ativa"`, `"active"` minúsculo) fazia a garantia
// silenciosamente não contar, sem erro nenhum no cadastro — só aparecia depois, como bloqueio
// inexplicado na ativação do contrato. Agora é validado contra um enum fechado, igual ao
// restante do projeto.
const GUARANTEE_STATUSES = ['ACTIVE', 'RELEASED', 'CANCELLED'];

function assertValidDateRange(startsAt, endsAt) {
  if (startsAt && endsAt && new Date(endsAt).getTime() < new Date(startsAt).getTime()) {
    throw AppError.badRequest('"endsAt" não pode ser anterior a "startsAt".', 'LEGAL_GUARANTEE_VALIDATION');
  }
}

function assertValidValue(value) {
  if (value === undefined || value === null) return;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw AppError.badRequest('"value" deve ser um número positivo.', 'LEGAL_GUARANTEE_VALIDATION');
  }
}

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
  if (status !== undefined && !GUARANTEE_STATUSES.includes(status)) {
    throw AppError.badRequest(`"status" deve ser um de: ${GUARANTEE_STATUSES.join(', ')}.`, 'LEGAL_GUARANTEE_VALIDATION');
  }
  assertValidValue(value);
  assertValidDateRange(startsAt, endsAt);

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
  if (status !== undefined) {
    if (!GUARANTEE_STATUSES.includes(status)) {
      throw AppError.badRequest(`"status" deve ser um de: ${GUARANTEE_STATUSES.join(', ')}.`, 'LEGAL_GUARANTEE_VALIDATION');
    }
    guarantee.status = status;
  }
  if (startsAt !== undefined) guarantee.startsAt = startsAt;
  if (endsAt !== undefined) guarantee.endsAt = endsAt;
  assertValidDateRange(
    startsAt !== undefined ? startsAt : guarantee.startsAt,
    endsAt !== undefined ? endsAt : guarantee.endsAt
  );
  if (value !== undefined) {
    assertValidValue(value);
    guarantee.value = value;
  }
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
