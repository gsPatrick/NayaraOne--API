'use strict';

const { Contract, ContractParty } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishContractStatusChanged } = require('./legalEvents.service');

const CONTRACT_TYPES = ['SALE', 'LEASE', 'SERVICE'];

// Máquina de estados do Contract.status. Ordem linear conforme especificado no doc do Marco 5:
// DRAFT -> DOCUMENTS_PENDING -> LEGAL_REVIEW -> APPROVED -> SIGNING -> SIGNED -> ACTIVE.
// DECISÃO DE ENGENHARIA: nenhum caminho de "voltar" ou "cancelar" foi especificado no doc —
// modelamos apenas as transições avante da linha do tempo (nada de LEGAL_REVIEW -> DRAFT),
// e adicionamos CANCELLED como estado terminal alcançável de qualquer estado não-ACTIVE, já
// que todo processo de negócio real precisa de uma saída de cancelamento — mas isso NÃO está
// no doc, é decisão nossa, documentada aqui explicitamente.
const VALID_TRANSITIONS = {
  DRAFT: ['DOCUMENTS_PENDING', 'CANCELLED'],
  DOCUMENTS_PENDING: ['LEGAL_REVIEW', 'CANCELLED'],
  LEGAL_REVIEW: ['APPROVED', 'DOCUMENTS_PENDING', 'CANCELLED'],
  APPROVED: ['SIGNING', 'CANCELLED'],
  SIGNING: ['SIGNED', 'CANCELLED'],
  SIGNED: ['ACTIVE'],
  ACTIVE: [],
  CANCELLED: [],
};

// DECISÃO DE ENGENHARIA — "Requirements Gate": o doc pede para "escolher um ponto de
// verificação sensato e documentar". Escolhemos o ponto DRAFT -> DOCUMENTS_PENDING: antes de
// sair de rascunho, o contrato precisa ter as partes mínimas para o seu contract_type, porque
// a etapa seguinte (DOCUMENTS_PENDING) já pressupõe que sabemos QUEM vai assinar/documentar.
// Papéis mínimos por tipo de contrato (não estão explicitados literalmente no doc — inferidos
// dos party_role documentados em ContractParty: LANDLORD|TENANT|GUARANTOR|BUYER|SELLER):
const REQUIRED_ROLES_BY_TYPE = {
  LEASE: ['LANDLORD', 'TENANT'],
  SALE: ['SELLER', 'BUYER'],
  SERVICE: [], // prestação de serviço não tem papéis fixos definidos no doc — sem gate de partes.
};

async function assertRequirementsGate(contract, transaction) {
  const requiredRoles = REQUIRED_ROLES_BY_TYPE[contract.contractType] || [];
  if (requiredRoles.length === 0) return;

  const parties = await ContractParty.findAll({ where: { contractId: contract.id }, transaction });
  const presentRoles = new Set(parties.map((p) => p.partyRole));
  const missing = requiredRoles.filter((role) => !presentRoles.has(role));
  if (missing.length > 0) {
    throw AppError.conflict(
      `Contrato do tipo "${contract.contractType}" precisa ter partes com os papéis: ${missing.join(', ')} antes de avançar de status.`,
      'LEGAL_CONTRACT_REQUIREMENTS_GATE'
    );
  }
}

async function createContract(payload, actorUserId, transaction) {
  const { groupId, companyId, propertyId, opportunityId, contractType, contractNumber, totalValue, startsAt, endsAt } = payload;
  if (!groupId || !companyId || !contractType) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "contractType" são obrigatórios.', 'LEGAL_CONTRACT_VALIDATION');
  }
  if (!CONTRACT_TYPES.includes(contractType)) {
    throw AppError.badRequest(`"contractType" deve ser um de: ${CONTRACT_TYPES.join(', ')}.`, 'LEGAL_CONTRACT_VALIDATION');
  }

  const contract = await Contract.create(
    {
      groupId,
      companyId,
      propertyId: propertyId || null,
      opportunityId: opportunityId || null,
      contractType,
      contractNumber: contractNumber || null,
      status: 'DRAFT',
      totalValue: totalValue !== undefined ? totalValue : null,
      startsAt: startsAt || null,
      endsAt: endsAt || null,
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
      action: 'legal.contract.create',
      entityType: 'Contract',
      entityId: contract.id,
      afterJson: contract.toJSON(),
      reason: `Contrato do tipo "${contractType}" criado em DRAFT.`,
    },
    transaction
  );

  return contract;
}

async function listContracts(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.contractType) where.contractType = String(filters.contractType).toUpperCase();
  if (filters.propertyId) where.propertyId = filters.propertyId;
  return Contract.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getContract(id, transaction) {
  const contract = await Contract.findByPk(id, { transaction });
  if (!contract) throw AppError.notFound('Contrato não encontrado.', 'LEGAL_CONTRACT_NOT_FOUND');
  return contract;
}

/**
 * transitionContractStatus — valida a transição contra VALID_TRANSITIONS, roda o
 * Requirements Gate quando a transição de saída é DRAFT -> DOCUMENTS_PENDING, persiste,
 * audita e publica o evento de domínio. Sempre recebe/retorna a MESMA instância `contract`
 * (evita 2 SELECTs quando o chamador já a tem em mãos, ex.: signatures.service.js).
 */
async function transitionContractStatus(contract, targetStatus, actorUserId, transaction) {
  const fromStatus = contract.status;
  const allowedTargets = VALID_TRANSITIONS[fromStatus] || [];
  if (!allowedTargets.includes(targetStatus)) {
    throw AppError.conflict(
      `Transição de status inválida: "${fromStatus}" -> "${targetStatus}". Transições permitidas a partir de "${fromStatus}": ${allowedTargets.join(', ') || '(nenhuma)'}.`,
      'LEGAL_CONTRACT_INVALID_TRANSITION'
    );
  }

  if (fromStatus === 'DRAFT' && targetStatus === 'DOCUMENTS_PENDING') {
    await assertRequirementsGate(contract, transaction);
  }

  const beforeJson = contract.toJSON();
  contract.status = targetStatus;
  contract.updatedBy = actorUserId || null;
  await contract.save({ transaction });

  await publishContractStatusChanged(contract, fromStatus, transaction);

  await registrarAuditoria(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      actorUserId,
      action: 'legal.contract.status_change',
      entityType: 'Contract',
      entityId: contract.id,
      beforeJson,
      afterJson: contract.toJSON(),
      reason: `Contrato transicionado de "${fromStatus}" para "${targetStatus}".`,
    },
    transaction
  );

  return contract;
}

async function addContractParty(contractId, payload, actorUserId, transaction) {
  const contract = await getContract(contractId, transaction);
  const { personId, partyRole } = payload;
  const VALID_ROLES = ['LANDLORD', 'TENANT', 'GUARANTOR', 'BUYER', 'SELLER'];
  if (!personId || !partyRole) {
    throw AppError.badRequest('Os campos "personId" e "partyRole" são obrigatórios.', 'LEGAL_CONTRACT_PARTY_VALIDATION');
  }
  if (!VALID_ROLES.includes(partyRole)) {
    throw AppError.badRequest(`"partyRole" deve ser um de: ${VALID_ROLES.join(', ')}.`, 'LEGAL_CONTRACT_PARTY_VALIDATION');
  }

  const party = await ContractParty.create(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      contractId: contract.id,
      personId,
      partyRole,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      actorUserId,
      action: 'legal.contract_party.create',
      entityType: 'ContractParty',
      entityId: party.id,
      afterJson: party.toJSON(),
      reason: `Parte "${partyRole}" adicionada ao contrato ${contract.id}.`,
    },
    transaction
  );

  return party;
}

async function listContractParties(contractId, transaction) {
  return ContractParty.findAll({ where: { contractId }, transaction });
}

module.exports = {
  createContract,
  listContracts,
  getContract,
  transitionContractStatus,
  addContractParty,
  listContractParties,
  CONTRACT_TYPES,
  VALID_TRANSITIONS,
  REQUIRED_ROLES_BY_TYPE,
};
