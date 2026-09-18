'use strict';

const { ContractAmendment, File } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { getContract } = require('./contracts.service');

/**
 * contractAmendments.service — M5-25: ADITIVO CONTRATUAL como entidade própria.
 *
 * Por que não é "só mais uma ContractVersion": uma ContractVersion troca o documento inteiro e
 * guarda um hash do conteúdo — ela não responde "o que exatamente mudou e por quê". O aditivo
 * responde: `changes_json` lista {field, oldValue, newValue}, `reason` justifica, e
 * `amendment_number` dá a numeração sequencial POR CONTRATO que advogado e cartório esperam
 * ("1º aditivo", "2º aditivo"). As duas entidades convivem: normalmente cria-se o aditivo e,
 * se houver um novo documento consolidado, também uma nova ContractVersion.
 *
 * APPEND-ONLY: não existe `updateAmendment` nem `deleteAmendment` propositalmente. O único
 * campo mutável é `status`, e só no sentido DRAFT -> SIGNED (signAmendment) — assinar não
 * reescreve histórico, registra um fato novo.
 *
 * NOTIFICAÇÃO ÀS PARTES ao assinar — DECISÃO DOCUMENTADA: NÃO foi implementada. As partes de
 * um contrato são `people.persons` (ContractParty.personId), não `core.users`, e
 * core.notifications.user_id é FK obrigatória para core.users — não há como notificar uma
 * Person pelo mecanismo de Notification existente sem inventar um vínculo person->user que o
 * sistema ainda não tem. Em vez de fabricar isso, a assinatura do aditivo é registrada na
 * auditoria (ação `legal.contract_amendment.sign`); quando existir o mapeamento person->user
 * (ou um canal de e-mail/WhatsApp real para Person), o disparo entra aqui, em signAmendment.
 */

const AMENDMENT_STATUSES = ['DRAFT', 'SIGNED'];

function validateChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw AppError.badRequest(
      '"changes" deve ser uma lista não vazia de alterações {field, oldValue, newValue}.',
      'LEGAL_CONTRACT_AMENDMENT_VALIDATION'
    );
  }
  for (const change of changes) {
    if (!change || typeof change !== 'object' || !change.field) {
      throw AppError.badRequest(
        'Cada alteração do aditivo precisa de ao menos "field".',
        'LEGAL_CONTRACT_AMENDMENT_VALIDATION'
      );
    }
  }
  return changes.map((change) => ({
    field: change.field,
    oldValue: change.oldValue !== undefined ? change.oldValue : null,
    newValue: change.newValue !== undefined ? change.newValue : null,
  }));
}

async function createAmendment(contractId, payload, actorUserId, transaction) {
  const contract = await getContract(contractId, transaction);
  const { reason, changes, documentFileId, status } = payload;

  if (!reason || !String(reason).trim()) {
    throw AppError.badRequest('O campo "reason" é obrigatório no aditivo.', 'LEGAL_CONTRACT_AMENDMENT_VALIDATION');
  }
  const normalizedChanges = validateChanges(changes);

  const requestedStatus = status || 'DRAFT';
  if (!AMENDMENT_STATUSES.includes(requestedStatus)) {
    throw AppError.badRequest(
      `"status" deve ser um de: ${AMENDMENT_STATUSES.join(', ')}.`,
      'LEGAL_CONTRACT_AMENDMENT_VALIDATION'
    );
  }

  if (documentFileId) {
    const file = await File.findByPk(documentFileId, { transaction });
    if (!file) throw AppError.notFound('Arquivo do aditivo não encontrado.', 'LEGAL_CONTRACT_AMENDMENT_FILE_NOT_FOUND');
  }
  // Um aditivo já assinado sem o documento assinado anexado não é prova de nada.
  if (requestedStatus === 'SIGNED' && !documentFileId) {
    throw AppError.badRequest(
      'Aditivo com status "SIGNED" exige "documentFileId" (o documento assinado).',
      'LEGAL_CONTRACT_AMENDMENT_DOCUMENT_REQUIRED'
    );
  }

  // Numeração sequencial POR CONTRATO. A UNIQUE (contract_id, amendment_number) no banco é a
  // garantia final contra corrida: se duas transações concorrentes lerem o mesmo "último
  // número", a segunda falha no commit em vez de gravar dois "2º aditivo".
  const last = await ContractAmendment.findOne({
    where: { contractId: contract.id },
    order: [['amendment_number', 'DESC']],
    transaction,
  });
  const amendmentNumber = last ? last.amendmentNumber + 1 : 1;

  const amendment = await ContractAmendment.create(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      contractId: contract.id,
      amendmentNumber,
      reason,
      changesJson: normalizedChanges,
      documentFileId: documentFileId || null,
      status: requestedStatus,
      createdBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      actorUserId,
      action: 'legal.contract_amendment.create',
      entityType: 'ContractAmendment',
      entityId: amendment.id,
      afterJson: amendment.toJSON(),
      reason: `${amendmentNumber}º aditivo do contrato ${contract.id} criado (${requestedStatus}): ${reason}`,
    },
    transaction
  );

  return amendment;
}

async function listAmendments(contractId, transaction) {
  return ContractAmendment.findAll({
    where: { contractId },
    order: [['amendment_number', 'ASC']],
    transaction,
  });
}

async function getAmendment(id, transaction) {
  const amendment = await ContractAmendment.findByPk(id, { transaction });
  if (!amendment) throw AppError.notFound('Aditivo contratual não encontrado.', 'LEGAL_CONTRACT_AMENDMENT_NOT_FOUND');
  return amendment;
}

/**
 * signAmendment — única mutação permitida: DRAFT -> SIGNED, exigindo o arquivo do documento
 * assinado. Conteúdo (reason/changes/numeração) permanece imutável.
 */
async function signAmendment(id, payload, actorUserId, transaction) {
  const amendment = await getAmendment(id, transaction);
  if (amendment.status === 'SIGNED') {
    throw AppError.conflict('Aditivo já está assinado.', 'LEGAL_CONTRACT_AMENDMENT_ALREADY_SIGNED');
  }

  const documentFileId = (payload && payload.documentFileId) || amendment.documentFileId;
  if (!documentFileId) {
    throw AppError.badRequest(
      'Para assinar o aditivo é obrigatório informar "documentFileId" (documento assinado).',
      'LEGAL_CONTRACT_AMENDMENT_DOCUMENT_REQUIRED'
    );
  }
  const file = await File.findByPk(documentFileId, { transaction });
  if (!file) throw AppError.notFound('Arquivo do aditivo não encontrado.', 'LEGAL_CONTRACT_AMENDMENT_FILE_NOT_FOUND');

  const beforeJson = amendment.toJSON();
  amendment.status = 'SIGNED';
  amendment.documentFileId = documentFileId;
  await amendment.save({ transaction });

  await registrarAuditoria(
    {
      groupId: amendment.groupId,
      companyId: amendment.companyId,
      actorUserId,
      action: 'legal.contract_amendment.sign',
      entityType: 'ContractAmendment',
      entityId: amendment.id,
      beforeJson,
      afterJson: amendment.toJSON(),
      reason: `${amendment.amendmentNumber}º aditivo do contrato ${amendment.contractId} assinado.`,
    },
    transaction
  );

  return amendment;
}

module.exports = { createAmendment, listAmendments, getAmendment, signAmendment, AMENDMENT_STATUSES };
