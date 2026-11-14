'use strict';

const { Inspection, InspectionSignature } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { isSaleLikeContractType } = require('../contracts/application/contract.service');

/** Vistoria que libera a entrega de chaves (livro §10 "Exigir vistoria final/entrada assinada quando aplicável"). */
// Fechamento M5 (Caderno §10 "Exigir vistoria final/entrada assinada quando aplicável"): locação exige
// a vistoria de ENTRADA (CHECK_IN); venda (entrega de casa nova) aceita a vistoria FINAL ou a de entrada.
function deliveryInspectionTypes(contract) {
  return isSaleLikeContractType(contract.contractType) ? ['FINAL', 'ENTRY'] : ['ENTRY'];
}

/** Vistoria concluída e assinada por locador e locatário que vale para esta entrega (ou recusa com o motivo). */
async function resolveDeliveryInspection(keyDelivery, contract, transaction) {
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
      where: { id: keyDelivery.inspectionId, contractId: contract.id, inspectionType: deliveryInspectionTypes(contract), status: 'COMPLETED' },
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
      where: { contractId: contract.id, inspectionType: deliveryInspectionTypes(contract), status: 'COMPLETED' },
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
      // Fechamento M5 (Caderno §10 / JUR-005): só vale a vistoria do imóvel SEM contrato — a
      // vistoria de entrada de OUTRO contrato (ex.: do locatário anterior) não libera esta entrega.
      checkIn = await Inspection.findOne({
        where: { propertyId: contract.propertyId, contractId: null, inspectionType: deliveryInspectionTypes(contract), status: 'COMPLETED' },
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

  return checkIn;
}

module.exports = { deliveryInspectionTypes, resolveDeliveryInspection };
