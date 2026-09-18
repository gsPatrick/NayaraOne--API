'use strict';

const { Op } = require('sequelize');
const { Proposal, Opportunity, Property, Person } = require('../../models');
const AppError = require('../../utils/AppError');
const { publishDomainEvent } = require('../../engines/events/outbox');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

/**
 * M3-13 / M3-25 — Proposta (crm.proposals) como entidade REAL, separada da Opportunity.
 *
 * REGRA CENTRAL — APPEND-ONLY POR VERSÃO: uma proposta nunca tem o seu `value` reescrito
 * depois de sair de DRAFT. Cada contraproposta para o mesmo (opportunity, property) é uma
 * LINHA NOVA com `versionNumber` = maior versão existente + 1. Isso preserva o histórico
 * completo da negociação (era exatamente o que se perdia antes, quando o valor vivia num
 * campo único `opportunities.expected_value` sobrescrito a cada rodada).
 *
 * `updateProposalStatus` é a ÚNICA mutação permitida sobre uma proposta existente, e mesmo
 * assim só sobre `status` (+ carimbos sentAt/decidedAt/decidedByUserId e `notes`): não existe
 * nenhum caminho neste service que altere `value` de uma proposta já persistida.
 */

const STATUSES = ['DRAFT', 'SENT', 'UNDER_NEGOTIATION', 'ACCEPTED', 'REJECTED', 'EXPIRED'];
const TERMINAL_STATUSES = ['ACCEPTED', 'REJECTED', 'EXPIRED'];

/**
 * Máquina de estados da proposta (decisão de engenharia documentada: o Caderno lista os
 * status, não as transições). DRAFT ainda é rascunho interno; SENT já foi para o cliente;
 * UNDER_NEGOTIATION é contraproposta em andamento; ACCEPTED/REJECTED/EXPIRED são terminais e
 * não voltam atrás (uma negociação que "revive" é uma NOVA VERSÃO, não um status revertido).
 */
const ALLOWED_TRANSITIONS = {
  DRAFT: ['SENT', 'REJECTED', 'EXPIRED'],
  SENT: ['UNDER_NEGOTIATION', 'ACCEPTED', 'REJECTED', 'EXPIRED'],
  UNDER_NEGOTIATION: ['ACCEPTED', 'REJECTED', 'EXPIRED'],
  ACCEPTED: [],
  REJECTED: [],
  EXPIRED: [],
};

async function createProposal(payload, actorUserId, transaction) {
  const {
    groupId,
    companyId,
    opportunityId,
    propertyId,
    proposedByPersonId,
    value,
    currency,
    status,
    notes,
    validUntil,
  } = payload;

  if (!groupId || !companyId || !opportunityId) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId" e "opportunityId" são obrigatórios.',
      'PROPOSAL_VALIDATION'
    );
  }
  if (value === undefined || value === null || Number.isNaN(Number(value))) {
    throw AppError.badRequest('O campo "value" é obrigatório e deve ser numérico.', 'PROPOSAL_VALIDATION');
  }
  if (Number(value) <= 0) {
    throw AppError.badRequest('O campo "value" deve ser maior que zero.', 'PROPOSAL_VALIDATION');
  }

  const normalizedStatus = status ? String(status).toUpperCase() : 'DRAFT';
  if (!STATUSES.includes(normalizedStatus)) {
    throw AppError.badRequest(`O campo "status" deve ser um de: ${STATUSES.join(', ')}.`, 'PROPOSAL_VALIDATION');
  }
  if (TERMINAL_STATUSES.includes(normalizedStatus)) {
    throw AppError.unprocessable(
      'Uma proposta não pode ser criada já em estado terminal (ACCEPTED/REJECTED/EXPIRED).',
      'PROPOSAL_INVALID_INITIAL_STATUS',
      { status: normalizedStatus }
    );
  }

  const opportunity = await Opportunity.findByPk(opportunityId, { transaction });
  if (!opportunity) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');

  const resolvedPropertyId = propertyId !== undefined ? propertyId : opportunity.propertyId;
  if (resolvedPropertyId) {
    const property = await Property.findByPk(resolvedPropertyId, { transaction });
    if (!property) throw AppError.notFound('Imóvel da proposta não encontrado.', 'PROPERTY_NOT_FOUND');
  }

  const resolvedPersonId = proposedByPersonId !== undefined ? proposedByPersonId : opportunity.personId;
  if (resolvedPersonId) {
    const person = await Person.findByPk(resolvedPersonId, { transaction });
    if (!person) throw AppError.notFound('Pessoa proponente não encontrada.', 'PERSON_NOT_FOUND');
  }

  // Versionamento append-only: a nova proposta é sempre a próxima versão da negociação
  // daquele (opportunity, property) — nunca um update da anterior.
  const previous = await Proposal.findOne({
    where: {
      opportunityId,
      propertyId: resolvedPropertyId || null,
    },
    order: [['version_number', 'DESC']],
    transaction,
  });
  const versionNumber = previous ? previous.versionNumber + 1 : 1;

  const proposal = await Proposal.create(
    {
      groupId,
      companyId,
      opportunityId,
      propertyId: resolvedPropertyId || null,
      proposedByPersonId: resolvedPersonId || null,
      value,
      currency: currency ? String(currency).toUpperCase() : 'BRL',
      status: normalizedStatus,
      versionNumber,
      notes: notes || null,
      validUntil: validUntil || null,
      sentAt: normalizedStatus === 'SENT' ? new Date() : null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishDomainEvent(
    {
      groupId,
      companyId,
      aggregateType: 'Proposal',
      aggregateId: proposal.id,
      eventType: 'crm.proposal.created',
      payload: {
        id: proposal.id,
        opportunityId,
        propertyId: proposal.propertyId,
        value: proposal.value,
        status: proposal.status,
        versionNumber,
      },
      idempotencyKey: `crm.proposal.created:${proposal.id}`,
    },
    transaction
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'proposal.create',
      entityType: 'Proposal',
      entityId: proposal.id,
      afterJson: proposal.toJSON(),
      reason: `Proposta v${versionNumber} criada na oportunidade ${opportunityId} no valor de ${proposal.value}.`,
    },
    transaction
  );

  return proposal;
}

async function listProposals(transaction, filters = {}) {
  const where = {};
  if (filters.opportunityId) where.opportunityId = filters.opportunityId;
  if (filters.propertyId) where.propertyId = filters.propertyId;
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.statusIn) where.status = { [Op.in]: filters.statusIn.map((s) => String(s).toUpperCase()) };
  return Proposal.findAll({
    where,
    order: [
      ['opportunity_id', 'ASC'],
      ['version_number', 'DESC'],
    ],
    transaction,
  });
}

async function getProposal(id, transaction) {
  const proposal = await Proposal.findByPk(id, { transaction });
  if (!proposal) throw AppError.notFound('Proposta não encontrada.', 'PROPOSAL_NOT_FOUND');
  return proposal;
}

/**
 * updateProposalStatus — única mutação permitida numa proposta já persistida. Rejeita
 * explicitamente qualquer tentativa de alterar `value` (o payload é ignorado por construção,
 * mas checamos e devolvemos 422 explicando o caminho correto: criar uma NOVA VERSÃO).
 */
async function updateProposalStatus(id, payload, actorUserId, transaction) {
  const proposal = await getProposal(id, transaction);
  const beforeJson = proposal.toJSON();
  const { status, notes, value } = payload || {};

  if (value !== undefined && Number(value) !== Number(proposal.value)) {
    throw AppError.unprocessable(
      'O valor de uma proposta é imutável (histórico append-only). Crie uma NOVA VERSÃO da proposta com POST /crm/proposals.',
      'PROPOSAL_VALUE_IMMUTABLE',
      { proposalId: id, currentValue: proposal.value }
    );
  }

  if (!status) {
    throw AppError.badRequest('O campo "status" é obrigatório.', 'PROPOSAL_VALIDATION');
  }
  const nextStatus = String(status).toUpperCase();
  if (!STATUSES.includes(nextStatus)) {
    throw AppError.badRequest(`O campo "status" deve ser um de: ${STATUSES.join(', ')}.`, 'PROPOSAL_VALIDATION');
  }

  if (nextStatus !== proposal.status && !ALLOWED_TRANSITIONS[proposal.status].includes(nextStatus)) {
    throw AppError.unprocessable(
      `Transição de status inválida: "${proposal.status}" -> "${nextStatus}".`,
      'PROPOSAL_INVALID_TRANSITION',
      { from: proposal.status, to: nextStatus, allowed: ALLOWED_TRANSITIONS[proposal.status] }
    );
  }

  const previousStatus = proposal.status;
  proposal.status = nextStatus;
  if (notes !== undefined) proposal.notes = notes;
  if (nextStatus === 'SENT' && !proposal.sentAt) proposal.sentAt = new Date();
  if (TERMINAL_STATUSES.includes(nextStatus)) {
    proposal.decidedAt = new Date();
    proposal.decidedByUserId = actorUserId || null;
  }
  proposal.updatedBy = actorUserId || null;
  await proposal.save({ transaction });

  await publishDomainEvent(
    {
      groupId: proposal.groupId,
      companyId: proposal.companyId,
      aggregateType: 'Proposal',
      aggregateId: proposal.id,
      eventType: 'crm.proposal.status_changed',
      payload: { id: proposal.id, fromStatus: previousStatus, toStatus: nextStatus },
      idempotencyKey: `crm.proposal.status_changed:${proposal.id}:${nextStatus}:${Date.now()}`,
    },
    transaction
  );

  await registrarAuditoria(
    {
      groupId: proposal.groupId,
      companyId: proposal.companyId,
      actorUserId,
      action: 'proposal.status_change',
      entityType: 'Proposal',
      entityId: proposal.id,
      beforeJson,
      afterJson: proposal.toJSON(),
      reason: `Proposta v${proposal.versionNumber} mudou de "${previousStatus}" para "${nextStatus}".`,
    },
    transaction
  );

  return proposal;
}

module.exports = {
  STATUSES,
  TERMINAL_STATUSES,
  ALLOWED_TRANSITIONS,
  createProposal,
  listProposals,
  getProposal,
  updateProposalStatus,
};
