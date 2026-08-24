'use strict';

const { KeyDelivery, Inspection } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishKeyDeliveryReleased } = require('./legalEvents.service');
const { getContract } = require('./contracts.service');

async function createKeyDelivery(payload, actorUserId, transaction) {
  const { groupId, companyId, contractId, inspectionId, deliveredToPersonId, notes } = payload;
  if (!groupId || !companyId || !contractId || !deliveredToPersonId) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "contractId" e "deliveredToPersonId" são obrigatórios.',
      'LEGAL_KEY_DELIVERY_VALIDATION'
    );
  }

  const keyDelivery = await KeyDelivery.create(
    {
      groupId,
      companyId,
      contractId,
      inspectionId: inspectionId || null,
      deliveredToPersonId,
      deliveredByUserId: null,
      deliveredAt: null,
      status: 'PENDING',
      notes: notes || null,
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
      action: 'legal.key_delivery.create',
      entityType: 'KeyDelivery',
      entityId: keyDelivery.id,
      afterJson: keyDelivery.toJSON(),
      reason: `Entrega de chaves registrada como PENDING para o contrato ${contractId}.`,
    },
    transaction
  );

  return keyDelivery;
}

async function listKeyDeliveries(transaction, filters = {}) {
  const where = {};
  if (filters.contractId) where.contractId = filters.contractId;
  if (filters.status) where.status = String(filters.status).toUpperCase();
  return KeyDelivery.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getKeyDelivery(id, transaction) {
  const keyDelivery = await KeyDelivery.findByPk(id, { transaction });
  if (!keyDelivery) throw AppError.notFound('Entrega de chaves não encontrada.', 'LEGAL_KEY_DELIVERY_NOT_FOUND');
  return keyDelivery;
}

/**
 * releaseKeyDelivery — TRAVA de negócio: só libera se o Contract estiver em SIGNED/ACTIVE E
 * existir uma Inspection CHECK_IN COMPLETED para o mesmo contrato (ou, na ausência de
 * contract_id na vistoria, para o mesmo imóvel do contrato — contratos de venda podem ter
 * vistorias sem vínculo direto, mas o caso de uso central aqui é locação).
 */
async function releaseKeyDelivery(id, actorUserId, transaction) {
  const keyDelivery = await getKeyDelivery(id, transaction);
  if (keyDelivery.status === 'RELEASED') {
    throw AppError.conflict('Entrega de chaves já foi liberada.', 'LEGAL_KEY_DELIVERY_ALREADY_RELEASED');
  }

  const contract = await getContract(keyDelivery.contractId, transaction);
  if (!['SIGNED', 'ACTIVE'].includes(contract.status)) {
    throw AppError.conflict(
      'Não é possível liberar as chaves: contrato precisa estar assinado/ativo e a vistoria de entrada concluída.',
      'LEGAL_KEY_DELIVERY_BLOCKED'
    );
  }

  const checkInWhere = { contractId: contract.id, inspectionType: 'CHECK_IN', status: 'COMPLETED' };
  let checkIn = await Inspection.findOne({ where: checkInWhere, transaction });
  if (!checkIn && contract.propertyId) {
    // Fallback: algumas vistorias de CHECK_IN podem não estar diretamente vinculadas ao
    // contrato (contract_id nullable em Inspection) — aceitamos também uma vistoria concluída
    // do mesmo imóvel. Decisão de engenharia: sem isso, contratos criados após a vistoria (ou
    // vistorias registradas antes do contrato existir) nunca liberariam a chave.
    checkIn = await Inspection.findOne({
      where: { propertyId: contract.propertyId, inspectionType: 'CHECK_IN', status: 'COMPLETED' },
      transaction,
    });
  }
  if (!checkIn) {
    throw AppError.conflict(
      'Não é possível liberar as chaves: contrato precisa estar assinado/ativo e a vistoria de entrada concluída.',
      'LEGAL_KEY_DELIVERY_BLOCKED'
    );
  }

  const beforeJson = keyDelivery.toJSON();
  keyDelivery.status = 'RELEASED';
  keyDelivery.deliveredAt = new Date();
  keyDelivery.deliveredByUserId = actorUserId || null;
  keyDelivery.updatedBy = actorUserId || null;
  await keyDelivery.save({ transaction });

  await publishKeyDeliveryReleased(keyDelivery, transaction);

  await registrarAuditoria(
    {
      groupId: keyDelivery.groupId,
      companyId: keyDelivery.companyId,
      actorUserId,
      action: 'legal.key_delivery.release',
      entityType: 'KeyDelivery',
      entityId: keyDelivery.id,
      beforeJson,
      afterJson: keyDelivery.toJSON(),
      reason: `Chaves do contrato ${contract.id} liberadas.`,
    },
    transaction
  );

  return keyDelivery;
}

module.exports = { createKeyDelivery, listKeyDeliveries, getKeyDelivery, releaseKeyDelivery };
