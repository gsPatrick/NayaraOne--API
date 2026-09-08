'use strict';

const { RentAdvance, Contract } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { createFinancialEntry } = require('../finance/financialEntries.service');
const { publishAdvanceCompleted } = require('./billingEvents.service');

// PRODUTO SEPARADO de guaranteed_rent_contracts (ver guaranteedRent.service.js) — tabela e
// fluxo próprios (eligibility -> proposal -> acceptance -> payment -> recovery), nunca
// misturados com o modelo de aluguel garantido.
const STATUS_FLOW = {
  ELIGIBILITY_PENDING: ['PROPOSED', 'REJECTED'],
  PROPOSED: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: ['PAID'],
  PAID: ['RECOVERING'],
  RECOVERING: ['RECOVERED'],
  RECOVERED: [],
  REJECTED: [],
};

/**
 * requestRentAdvance — abre uma solicitação de antecipação de aluguel (estado inicial
 * ELIGIBILITY_PENDING). O contrato precisa existir e estar ACTIVE.
 *
 * DECISÃO DE ENGENHARIA — não especificado no Caderno: critério de elegibilidade não é
 * detalhado no Caderno. Usamos como default mínimo "contrato do tipo LEASE e status ACTIVE" —
 * qualquer regra de score de crédito/histórico de pagamento fica fora de escopo até ser
 * confirmada pelo cliente.
 */
async function requestRentAdvance(payload, actorUserId, transaction) {
  const { groupId, companyId, contractId, monthsAdvanced, principalAmount, costAmount } = payload;
  if (!groupId || !companyId || !contractId || !monthsAdvanced || principalAmount === undefined || principalAmount === null) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "contractId", "monthsAdvanced" e "principalAmount" são obrigatórios.',
      'RENT_ADVANCE_VALIDATION'
    );
  }
  const contract = await Contract.findByPk(contractId, { transaction });
  if (!contract) throw AppError.notFound('Contrato não encontrado.', 'RENT_ADVANCE_CONTRACT_NOT_FOUND');
  if (contract.contractType !== 'LEASE' || contract.status !== 'ACTIVE') {
    throw AppError.unprocessable(
      'Antecipação de aluguel só é elegível para contratos de locação (LEASE) com status ACTIVE.',
      'RENT_ADVANCE_NOT_ELIGIBLE'
    );
  }

  const rentAdvance = await RentAdvance.create(
    {
      groupId,
      companyId,
      contractId,
      status: 'ELIGIBILITY_PENDING',
      monthsAdvanced,
      principalAmount,
      costAmount: costAmount || 0,
      recoveredAmount: 0,
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
      action: 'billing.rent_advance.request',
      entityType: 'RentAdvance',
      entityId: rentAdvance.id,
      afterJson: rentAdvance.toJSON(),
      reason: `Antecipação de aluguel solicitada para o contrato ${contractId}: ${monthsAdvanced} meses, principal ${principalAmount}.`,
    },
    transaction
  );

  return rentAdvance;
}

async function getRentAdvance(id, transaction) {
  const item = await RentAdvance.findByPk(id, { transaction });
  if (!item) throw AppError.notFound('Antecipação de aluguel não encontrada.', 'RENT_ADVANCE_NOT_FOUND');
  return item;
}

async function listRentAdvances(transaction, filters = {}) {
  const where = {};
  if (filters.contractId) where.contractId = filters.contractId;
  if (filters.status) where.status = String(filters.status).toUpperCase();
  return RentAdvance.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function transitionRentAdvance(rentAdvance, targetStatus, actorUserId, transaction) {
  const allowed = STATUS_FLOW[rentAdvance.status] || [];
  if (!allowed.includes(targetStatus)) {
    throw AppError.conflict(
      `Transição inválida: "${rentAdvance.status}" -> "${targetStatus}". Permitidas: ${allowed.join(', ') || '(nenhuma)'}.`,
      'RENT_ADVANCE_INVALID_TRANSITION'
    );
  }
  const beforeJson = rentAdvance.toJSON();
  rentAdvance.status = targetStatus;
  rentAdvance.updatedBy = actorUserId || null;
  await rentAdvance.save({ transaction });

  await registrarAuditoria(
    {
      groupId: rentAdvance.groupId,
      companyId: rentAdvance.companyId,
      actorUserId,
      action: 'billing.rent_advance.transition',
      entityType: 'RentAdvance',
      entityId: rentAdvance.id,
      beforeJson,
      afterJson: rentAdvance.toJSON(),
      reason: `Antecipação de aluguel transicionada de "${beforeJson.status}" para "${targetStatus}".`,
    },
    transaction
  );

  return rentAdvance;
}

async function proposeRentAdvance(id, actorUserId, transaction) {
  const rentAdvance = await getRentAdvance(id, transaction);
  rentAdvance.proposedAt = new Date();
  return transitionRentAdvance(rentAdvance, 'PROPOSED', actorUserId, transaction);
}

/**
 * acceptRentAdvance — aprova a antecipação proposta. Endpoint "aprovar antecipação" do DoD.
 */
async function acceptRentAdvance(id, actorUserId, transaction) {
  const rentAdvance = await getRentAdvance(id, transaction);
  rentAdvance.acceptedAt = new Date();
  return transitionRentAdvance(rentAdvance, 'ACCEPTED', actorUserId, transaction);
}

function rejectRentAdvance(rentAdvance, actorUserId, transaction) {
  return transitionRentAdvance(rentAdvance, 'REJECTED', actorUserId, transaction);
}

/**
 * payRentAdvance — libera o pagamento da antecipação já ACCEPTED. Principal e custo (juros/
 * taxa) são contabilizados SEPARADAMENTE — dois FinancialEntry distintos, nunca um único
 * lançamento misturando os dois (Caderno: "contabilizados separadamente no financeiro").
 */
async function payRentAdvance(id, actorUserId, transaction) {
  const rentAdvance = await getRentAdvance(id, transaction);
  if (rentAdvance.status !== 'ACCEPTED') {
    throw AppError.conflict(`Só é possível pagar uma antecipação ACCEPTED (atual: "${rentAdvance.status}").`, 'RENT_ADVANCE_INVALID_STATUS');
  }
  const beforeJson = rentAdvance.toJSON();

  const principalEntry = await createFinancialEntry(
    {
      groupId: rentAdvance.groupId,
      companyId: rentAdvance.companyId,
      contractId: rentAdvance.contractId,
      entryType: 'DEBIT',
      nature: 'PAYABLE',
      amount: rentAdvance.principalAmount,
      description: `Antecipação de aluguel — principal, contrato ${rentAdvance.contractId}.`,
      dueAt: new Date(),
      idempotencyKey: `rent_advance.principal:${rentAdvance.id}`,
    },
    actorUserId,
    transaction
  );

  let costEntry = null;
  if (Number(rentAdvance.costAmount) > 0) {
    costEntry = await createFinancialEntry(
      {
        groupId: rentAdvance.groupId,
        companyId: rentAdvance.companyId,
        contractId: rentAdvance.contractId,
        entryType: 'CREDIT',
        nature: 'RECEIVABLE',
        amount: rentAdvance.costAmount,
        description: `Antecipação de aluguel — custo/juros, contrato ${rentAdvance.contractId}.`,
        dueAt: new Date(),
        idempotencyKey: `rent_advance.cost:${rentAdvance.id}`,
      },
      actorUserId,
      transaction
    );
  }

  rentAdvance.principalEntryId = principalEntry.id;
  rentAdvance.costEntryId = costEntry ? costEntry.id : null;
  rentAdvance.paidAt = new Date();
  rentAdvance.status = 'PAID';
  rentAdvance.updatedBy = actorUserId || null;
  await rentAdvance.save({ transaction });

  await registrarAuditoria(
    {
      groupId: rentAdvance.groupId,
      companyId: rentAdvance.companyId,
      actorUserId,
      action: 'billing.rent_advance.pay',
      entityType: 'RentAdvance',
      entityId: rentAdvance.id,
      beforeJson,
      afterJson: rentAdvance.toJSON(),
      reason: `Antecipação de aluguel paga: principal ${rentAdvance.principalAmount}, custo ${rentAdvance.costAmount}.`,
    },
    transaction
  );

  return rentAdvance;
}

/**
 * recoverRentAdvance — registra a recuperação (do locatário) do valor antecipado, parcial ou
 * total. Marca RECOVERED quando o valor recuperado atinge principal + custo.
 */
async function recoverRentAdvance(id, amountRecovered, actorUserId, transaction) {
  const rentAdvance = await getRentAdvance(id, transaction);
  if (!['PAID', 'RECOVERING'].includes(rentAdvance.status)) {
    throw AppError.conflict('Só é possível recuperar uma antecipação PAID/RECOVERING.', 'RENT_ADVANCE_INVALID_STATUS');
  }
  const beforeJson = rentAdvance.toJSON();
  const newRecovered = Number(rentAdvance.recoveredAmount) + Number(amountRecovered);
  const totalDue = Number(rentAdvance.principalAmount) + Number(rentAdvance.costAmount);

  rentAdvance.recoveredAmount = newRecovered;
  rentAdvance.status = newRecovered >= totalDue ? 'RECOVERED' : 'RECOVERING';
  rentAdvance.updatedBy = actorUserId || null;
  await rentAdvance.save({ transaction });

  if (rentAdvance.status === 'RECOVERED') {
    await publishAdvanceCompleted(rentAdvance, transaction);
  }

  await registrarAuditoria(
    {
      groupId: rentAdvance.groupId,
      companyId: rentAdvance.companyId,
      actorUserId,
      action: 'billing.rent_advance.recover',
      entityType: 'RentAdvance',
      entityId: rentAdvance.id,
      beforeJson,
      afterJson: rentAdvance.toJSON(),
      reason: `Recuperação de ${amountRecovered} registrada (total recuperado: ${newRecovered} de ${totalDue}).`,
    },
    transaction
  );

  return rentAdvance;
}

module.exports = {
  requestRentAdvance,
  getRentAdvance,
  listRentAdvances,
  proposeRentAdvance,
  acceptRentAdvance,
  rejectRentAdvance,
  payRentAdvance,
  recoverRentAdvance,
};
