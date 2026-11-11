'use strict';

const { createKeyDelivery, releaseKeyDelivery, cancelKeyDelivery } = require('../../../../../modules/legal/leasing/key-delivery.service');
const { KeyDelivery, Contract } = require('../../../../../models');
const { findPersonByDocument } = require('../people');
const { resolveRef } = require('../refs');
const { commandRejected } = require('../../bcp.errors');
const normalize = require('../normalize');

/**
 * REGISTER_KEY_DELIVERY: a entrega de chaves do papel vira entrega de chaves do Jurídico (criada e liberada pelos serviços normais, com todas as travas: contrato assinado ou
 * ativo, vistoria de entrada assinada, garantia vigente, recebedor parte do contrato). O papel digitalizado é a foto da entrega e o recebedor assina o termo. Confere
 * contrato, imóvel e data da entrega.
 */
async function execute({ tenant, actorUserId, operation, payload, transaction }) {
  const contract = await resolveRef('contract', payload.contrato, tenant, transaction);
  const property = await resolveRef('property', payload.imovel, tenant, transaction);
  const recipient = await findPersonByDocument(payload.documentoRecebedor, transaction);
  const delivered = normalize.noonOf(payload.data);
  if (!delivered) throw commandRejected('a data da entrega é inválida');
  const created = await createKeyDelivery({
    groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, deliveredToPersonId: recipient.id,
    notes: `Origem BCP ${operation.manualReference}. Recebedor: ${payload.recebedor}.${payload.estadoImovel ? ` Estado do imóvel: ${payload.estadoImovel}` : ''}`.slice(0, 2000),
  }, actorUserId, transaction);
  const released = await releaseKeyDelivery(created.id, {
    keysCount: payload.quantidadeChaves, keysIdentification: `Formulário ${operation.manualReference}`, photosFileIds: [operation.evidenceFileId], termSignedByPersonId: recipient.id, termEvidenceFileId: operation.evidenceFileId,
  }, actorUserId, transaction, { deliveredAt: delivered });
  const saved = await KeyDelivery.findByPk(released.id, { transaction });
  const savedContract = await Contract.findByPk(saved.contractId, { transaction });
  return {
    commandRef: `KeyDelivery:${saved.id}`,
    undo: { keyDeliveryId: saved.id },
    comparisons: [
      { field: 'contrato', label: 'Contrato', paper: normalize.id(contract.id), command: normalize.id(saved.contractId), kind: 'ref' },
      { field: 'imovel', label: 'Imóvel', paper: normalize.id(property.id), command: normalize.id(savedContract && savedContract.propertyId), kind: 'ref' },
      { field: 'data', label: 'Data da entrega', paper: normalize.day(payload.data), command: normalize.day(saved.deliveredAt), kind: 'date' },
    ],
  };
}

/** Estorno: o serviço normal só cancela entrega PENDING; entrega liberada (termo assinado) é definitiva e a recusa dele (422) segue como está. */
async function reverse({ actorUserId, effect, operation, transaction }) {
  await cancelKeyDelivery(effect.keyDeliveryId, { reason: `Estorno da operação manual ${operation.manualReference} (BCP).` }, actorUserId, transaction);
}

module.exports = { action: 'REGISTER_KEY_DELIVERY', execute, reverse };
