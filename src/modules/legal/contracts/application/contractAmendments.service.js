'use strict';

const { ContractAmendment, ContractVersion, ContractParty, AddendumSignature, File } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { getContract, REQUIRED_ROLES_BY_TYPE } = require('./contract.service');
const { assertUuidFields } = require('../../shared/legalIds');

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

const today = () => new Date().toISOString().slice(0, 10);

/** Versão base do aditivo (Caderno §13): a informada (do mesmo contrato), senão a homologada, senão a vigente. */
async function resolveBaseVersion(contract, baseContractVersionId, transaction) {
  if (baseContractVersionId) {
    const v = await ContractVersion.findOne({ where: { id: baseContractVersionId, contractId: contract.id }, transaction });
    if (!v) throw AppError.notFound('Versão base informada não pertence a este contrato.', 'LEGAL_CONTRACT_AMENDMENT_BASE_VERSION_NOT_FOUND');
    return v;
  }
  if (contract.approvedVersionId) return ContractVersion.findByPk(contract.approvedVersionId, { transaction });
  const latest = await ContractVersion.findOne({ where: { contractId: contract.id }, order: [['version_number', 'DESC']], transaction });
  if (!latest) {
    throw AppError.conflict('O aditivo referencia a versão base do contrato: o contrato ainda não tem versão.', 'LEGAL_CONTRACT_AMENDMENT_BASE_VERSION_REQUIRED');
  }
  return latest;
}

function validateChangedClauses(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw AppError.badRequest('"changedClauses" deve ser uma lista de { code, change }.', 'LEGAL_CONTRACT_AMENDMENT_VALIDATION');
  return list.map((c) => {
    if (!c || typeof c !== 'object' || !c.code) throw AppError.badRequest('Cada cláusula alterada precisa de "code".', 'LEGAL_CONTRACT_AMENDMENT_VALIDATION');
    return { code: String(c.code), change: c.change !== undefined ? String(c.change) : null, contractClauseId: c.contractClauseId || null };
  });
}

function validateVigencia(effectiveFrom, effectiveUntil) {
  const from = effectiveFrom || today();
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(String(from)) || (effectiveUntil && !iso.test(String(effectiveUntil)))) {
    throw AppError.badRequest('Vigência do aditivo em AAAA-MM-DD ("effectiveFrom"/"effectiveUntil").', 'LEGAL_CONTRACT_AMENDMENT_VALIDATION');
  }
  if (effectiveUntil && effectiveUntil < from) throw AppError.badRequest('O fim da vigência do aditivo não pode ser antes do início.', 'LEGAL_CONTRACT_AMENDMENT_VALIDATION');
  return { from, until: effectiveUntil || null };
}

async function createAmendment(contractId, payload, actorUserId, transaction) {
  const contract = await getContract(contractId, transaction);
  assertUuidFields(payload, ['documentFileId', 'baseContractVersionId']);
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
  // Matriz M5 (§13 "assinaturas ficam registradas"): o aditivo nasce DRAFT e vira SIGNED pelas assinaturas
  // de cada signatário (POST /legal/amendments/:id/sign), nunca por um status informado na criação.
  if (requestedStatus === 'SIGNED') {
    throw AppError.badRequest('O aditivo nasce em rascunho: registre a assinatura de cada signatário em POST /legal/amendments/:id/sign.', 'LEGAL_CONTRACT_AMENDMENT_SIGNATURES_REQUIRED');
  }
  const changedClauses = validateChangedClauses(payload.changedClauses);
  const vigencia = validateVigencia(payload.effectiveFrom, payload.effectiveUntil);
  const base = await resolveBaseVersion(contract, payload.baseContractVersionId, transaction);

  if (documentFileId) {
    const file = await File.findByPk(documentFileId, { transaction });
    if (!file) throw AppError.notFound('Arquivo do aditivo não encontrado.', 'LEGAL_CONTRACT_AMENDMENT_FILE_NOT_FOUND');
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
      changedClauses,
      baseContractVersionId: base.id,
      effectiveFrom: vigencia.from,
      effectiveUntil: vigencia.until,
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
  amendment.dataValues.signatures = await AddendumSignature.findAll({ where: { addendumId: amendment.id }, order: [['signed_at', 'ASC']], transaction });
  return amendment;
}

/**
 * signAmendment — única mutação permitida: DRAFT -> SIGNED, exigindo o arquivo do documento
 * assinado. Conteúdo (reason/changes/numeração) permanece imutável.
 */
/** Signatários exigidos: os papéis obrigatórios do tipo do contrato; sem papel fixo, todas as partes. */
async function requiredSigners(amendment, transaction) {
  const contract = await getContract(amendment.contractId, transaction);
  const parties = await ContractParty.findAll({ where: { contractId: contract.id }, transaction });
  const roles = REQUIRED_ROLES_BY_TYPE[contract.contractType] || [];
  return roles.length ? parties.filter((p) => roles.includes(p.partyRole)) : parties;
}

/**
 * signAmendment — registra a assinatura de UM signatário (pessoa parte do contrato, via assinada e coletor) em
 * legal.addendum_signatures; o aditivo vira SIGNED quando todos os signatários exigidos assinaram. Conteúdo do
 * aditivo (motivo, alterações, vigência, versão base) permanece imutável.
 */
async function signAmendment(id, payload, actorUserId, transaction) {
  const amendment = await ContractAmendment.findByPk(id, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!amendment) throw AppError.notFound('Aditivo contratual não encontrado.', 'LEGAL_CONTRACT_AMENDMENT_NOT_FOUND');
  if (amendment.status === 'SIGNED') {
    throw AppError.conflict('Aditivo já está assinado.', 'LEGAL_CONTRACT_AMENDMENT_ALREADY_SIGNED');
  }
  assertUuidFields(payload, ['personId', 'evidenceFileId', 'documentFileId']);
  const { personId } = payload || {};
  const evidenceFileId = (payload && (payload.evidenceFileId || payload.documentFileId)) || null;
  if (!personId) {
    throw AppError.badRequest('Informe o signatário ("personId") — a assinatura do aditivo é registrada por signatário.', 'LEGAL_CONTRACT_AMENDMENT_SIGNER_REQUIRED');
  }
  if (!evidenceFileId) {
    throw AppError.badRequest('Para assinar o aditivo é obrigatório informar a via assinada ("evidenceFileId" ou "documentFileId").', 'LEGAL_CONTRACT_AMENDMENT_DOCUMENT_REQUIRED');
  }
  if (!actorUserId) throw AppError.badRequest('A assinatura do aditivo exige o responsável pela coleta.', 'LEGAL_CONTRACT_AMENDMENT_COLLECTOR_REQUIRED');
  const file = await File.findByPk(evidenceFileId, { transaction });
  if (!file) throw AppError.notFound('Arquivo do aditivo não encontrado.', 'LEGAL_CONTRACT_AMENDMENT_FILE_NOT_FOUND');
  const party = await ContractParty.findOne({ where: { contractId: amendment.contractId, personId }, transaction });
  if (!party) throw AppError.badRequest('O signatário precisa ser parte do contrato.', 'LEGAL_CONTRACT_AMENDMENT_SIGNER_NOT_PARTY');
  if (await AddendumSignature.findOne({ where: { addendumId: amendment.id, personId }, transaction })) {
    throw AppError.conflict('Este signatário já assinou o aditivo.', 'LEGAL_CONTRACT_AMENDMENT_SIGNER_ALREADY_SIGNED');
  }
  const signature = await AddendumSignature.create({
    groupId: amendment.groupId, companyId: amendment.companyId, addendumId: amendment.id, personId, partyRole: party.partyRole,
    evidenceFileId, collectedByUserId: actorUserId, signedAt: new Date(),
  }, { transaction });

  const signers = await requiredSigners(amendment, transaction);
  const signedIds = new Set((await AddendumSignature.findAll({ where: { addendumId: amendment.id }, transaction })).map((x) => x.personId));
  const complete = signers.length ? signers.every((p) => signedIds.has(p.personId)) : signedIds.size > 0;
  const beforeJson = amendment.toJSON();
  if (complete) {
    amendment.status = 'SIGNED';
    amendment.documentFileId = amendment.documentFileId || evidenceFileId;
    await amendment.save({ transaction });
  }

  await registrarAuditoria(
    {
      groupId: amendment.groupId,
      companyId: amendment.companyId,
      actorUserId,
      action: 'legal.contract_amendment.sign',
      entityType: 'ContractAmendment',
      entityId: amendment.id,
      beforeJson,
      afterJson: { ...amendment.toJSON(), signature: signature.toJSON() },
      reason: `${amendment.amendmentNumber}º aditivo do contrato ${amendment.contractId}: assinatura de ${personId} (${party.partyRole})${complete ? ' — todas as assinaturas exigidas concluídas' : ''}.`,
    },
    transaction
  );

  amendment.dataValues.signatures = await AddendumSignature.findAll({ where: { addendumId: amendment.id }, order: [['signed_at', 'ASC']], transaction });
  return amendment;
}

module.exports = { createAmendment, listAmendments, getAmendment, signAmendment, AMENDMENT_STATUSES };
