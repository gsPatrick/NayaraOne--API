'use strict';

const { KeyDelivery, Inspection, InspectionSignature, Guarantee } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishKeyDeliveryReleased, publishKeysDelivered } = require('./legalEvents.service');
const { getContract } = require('./contracts.service');

// Caderno Anexo I "3. Tipos de contrato": termos específicos de entrega — KEY_DELIVERY (entrega
// de chaves padrão) e USED_PROPERTY_DELIVERY (entrega de imóvel usado, termo específico
// deixando clara a natureza/estado do imóvel — ver "7. Checklist documental").
const TERM_TYPES = ['KEY_DELIVERY', 'USED_PROPERTY_DELIVERY'];

async function createKeyDelivery(payload, actorUserId, transaction) {
  const { groupId, companyId, contractId, inspectionId, deliveredToPersonId, notes, termType } = payload;
  if (!groupId || !companyId || !contractId || !deliveredToPersonId) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "contractId" e "deliveredToPersonId" são obrigatórios.',
      'LEGAL_KEY_DELIVERY_VALIDATION'
    );
  }
  if (termType !== undefined && termType !== null && !TERM_TYPES.includes(termType)) {
    throw AppError.badRequest(`"termType" deve ser um de: ${TERM_TYPES.join(', ')}.`, 'LEGAL_KEY_DELIVERY_VALIDATION');
  }

  // ADV (M5-32): o contrato NUNCA era carregado na criação — quem chamasse o service com o
  // UUID de um contrato de outra empresa e o próprio group/company no payload conseguia criar
  // uma entrega de chaves apontando para um contrato que não pode nem ler. `getContract` roda
  // sob o RLS do tenant do chamador, então um contrato de outro tenant simplesmente não existe
  // aqui (404) — e o group/company gravados passam a vir do CONTRATO, não do payload, para que
  // um payload forjado não consiga plantar a linha no tenant errado.
  const contract = await getContract(contractId, transaction);

  const keyDelivery = await KeyDelivery.create(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
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
  // NOTA DE AMBIENTE (ver migration 20260101000290, ainda não aplicada neste banco — mesma
  // limitação documentada em src/models/Guarantee.js): "termType" fica em memória até a coluna
  // existir fisicamente; não é persistido nem quebra o INSERT porque não é um atributo
  // declarado no model KeyDelivery.
  if (termType) keyDelivery.termType = termType;

  await registrarAuditoria(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
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
async function releaseKeyDelivery(id, payload, actorUserId, transaction) {
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

  // Caderno Anexo I "10. Entrega de chaves": "Exigir documentos e garantias válidos." Até aqui
  // só o gate de ATIVAÇÃO do contrato (assertActivationGate) reconferia garantias — a entrega de
  // chaves em si não checava nada. Mesmo espírito do gate de ativação: se o contrato tem alguma
  // Guarantee cadastrada, ao menos uma precisa estar ACTIVE (contrato sem nenhuma garantia
  // cadastrada não é bloqueado — "todo contrato exige garantia" não está no Caderno).
  const guarantees = await Guarantee.findAll({ where: { contractId: contract.id }, transaction });
  if (guarantees.length > 0 && !guarantees.some((g) => g.status === 'ACTIVE')) {
    throw AppError.conflict(
      'Não é possível liberar as chaves: existem garantias cadastradas para o contrato, mas nenhuma está com status "ACTIVE".',
      'LEGAL_KEY_DELIVERY_GUARANTEE_INVALID'
    );
  }

  // FIX (homologação, LOC-2026-0002): quando um contrato tem MAIS DE UMA vistoria de CHECK_IN
  // concluída (ex.: uma antiga já assinada, e uma nova ainda sem assinatura porque a antiga foi
  // refeita), `findOne` sem ORDER escolhia qualquer uma delas — na prática, muitas vezes a mais
  // antiga/assinada, autorizando a entrega mesmo a vistoria REALMENTE vinculada a esta entrega
  // de chaves (keyDelivery.inspectionId) estando pendente de assinatura. A vistoria que importa
  // para o gate é: (1) a explicitamente referenciada por esta entrega de chaves, se houver; ou
  // (2) na ausência de vínculo explícito, a vistoria de CHECK_IN concluída MAIS RECENTE do
  // contrato (nunca "qualquer uma que exista assinada") — ordenada por completed_at/created_at.
  let checkIn = null;
  if (keyDelivery.inspectionId) {
    checkIn = await Inspection.findOne({
      where: { id: keyDelivery.inspectionId, contractId: contract.id, inspectionType: 'CHECK_IN', status: 'COMPLETED' },
      transaction,
    });
    if (!checkIn) {
      throw AppError.conflict(
        'Não é possível liberar as chaves: a vistoria de entrada vinculada a esta entrega não está concluída.',
        'LEGAL_KEY_DELIVERY_BLOCKED'
      );
    }
  } else {
    checkIn = await Inspection.findOne({
      where: { contractId: contract.id, inspectionType: 'CHECK_IN', status: 'COMPLETED' },
      order: [
        ['completedAt', 'DESC'],
        ['created_at', 'DESC'],
      ],
      transaction,
    });
    if (!checkIn && contract.propertyId) {
      // Fallback: algumas vistorias de CHECK_IN podem não estar diretamente vinculadas ao
      // contrato (contract_id nullable em Inspection) — aceitamos também a vistoria concluída
      // MAIS RECENTE do mesmo imóvel. Decisão de engenharia: sem isso, contratos criados após a
      // vistoria (ou vistorias registradas antes do contrato existir) nunca liberariam a chave.
      checkIn = await Inspection.findOne({
        where: { propertyId: contract.propertyId, inspectionType: 'CHECK_IN', status: 'COMPLETED' },
        order: [
          ['completedAt', 'DESC'],
          ['created_at', 'DESC'],
        ],
        transaction,
      });
    }
  }
  if (!checkIn) {
    throw AppError.conflict(
      'Não é possível liberar as chaves: contrato precisa estar assinado/ativo e a vistoria de entrada concluída.',
      'LEGAL_KEY_DELIVERY_BLOCKED'
    );
  }

  // FIX (homologação 22/09/2026, reportado pela cliente): "concluída" (status COMPLETED) não
  // significa "assinada" — completeInspection nunca exigiu nenhuma InspectionSignature. Uma
  // vistoria podia ser marcada como concluída e liberar a chave sem locador NEM locatário terem
  // assinado nada, o que não cumpre o que o Caderno descreve para M5-22 ("vistoria de entrada
  // concluída E ASSINADA"). Exige as duas assinaturas de PARTE (LANDLORD e TENANT) — INSPECTOR é
  // opcional (vistoriador nem sempre é uma parte formal do contrato).
  const checkInSignatures = await InspectionSignature.findAll({ where: { inspectionId: checkIn.id }, transaction });
  const signedRoles = new Set(checkInSignatures.map((s) => s.partyRole));
  const missingRoles = ['LANDLORD', 'TENANT'].filter((role) => !signedRoles.has(role));
  if (missingRoles.length > 0) {
    throw AppError.conflict(
      `Não é possível liberar as chaves: a vistoria de entrada está concluída mas falta(m) a assinatura de ${missingRoles.join(' e ')}.`,
      'LEGAL_KEY_DELIVERY_INSPECTION_NOT_SIGNED'
    );
  }

  // Caderno Anexo I "10. Entrega de chaves": "Registrar quantidade/identificação de
  // chaves/controles", "Fotos obrigatórias quando política exigir", "Assinatura do termo de
  // entrega." Fail closed: exige quantidade E assinatura do termo (pessoa que coletou/assinou)
  // sempre — fotos só quando `photosRequired` (política) estiver marcada.
  const { keysCount, keysIdentification, photosRequired, photosFileIds, termSignedByPersonId } = payload || {};
  if (keysCount === undefined || keysCount === null || Number(keysCount) <= 0) {
    throw AppError.badRequest(
      '"keysCount" (quantidade de chaves/controles entregues) é obrigatório e deve ser maior que zero.',
      'LEGAL_KEY_DELIVERY_VALIDATION'
    );
  }
  if (!termSignedByPersonId) {
    throw AppError.badRequest(
      '"termSignedByPersonId" é obrigatório — a liberação de chaves exige assinatura do termo de entrega.',
      'LEGAL_KEY_DELIVERY_VALIDATION'
    );
  }
  if (photosRequired && (!Array.isArray(photosFileIds) || photosFileIds.length === 0)) {
    throw AppError.conflict(
      'Não é possível liberar as chaves: a política exige fotos obrigatórias e nenhuma foi informada ("photosFileIds").',
      'LEGAL_KEY_DELIVERY_PHOTOS_REQUIRED'
    );
  }

  const beforeJson = keyDelivery.toJSON();
  keyDelivery.status = 'RELEASED';
  keyDelivery.deliveredAt = new Date();
  keyDelivery.deliveredByUserId = actorUserId || null;
  keyDelivery.updatedBy = actorUserId || null;
  // NOTA DE AMBIENTE (ver migration 20260101000290, ainda não aplicada neste banco): estes
  // campos ficam em memória (refletidos no retorno/auditoria) até a coluna existir de fato —
  // mesma limitação documentada em src/models/Guarantee.js/guarantees.service.js#replaceGuarantee.
  keyDelivery.keysCount = Number(keysCount);
  keyDelivery.keysIdentification = keysIdentification || null;
  keyDelivery.photosFileIds = Array.isArray(photosFileIds) ? photosFileIds : null;
  keyDelivery.termSignedByPersonId = termSignedByPersonId;
  keyDelivery.termSignedAt = new Date();
  await keyDelivery.save({ transaction });

  await publishKeyDeliveryReleased(keyDelivery, transaction);
  await publishKeysDelivered(keyDelivery, transaction);

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
