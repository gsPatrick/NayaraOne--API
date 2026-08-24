'use strict';

const { CommunicationConsent, Person } = require('../../models');
const AppError = require('../../utils/AppError');

const VALID_CHANNELS = ['PHONE', 'WHATSAPP', 'EMAIL'];
const VALID_STATUSES = ['OPT_IN', 'OPT_OUT'];

async function assertPersonExists(personId, transaction) {
  const person = await Person.findByPk(personId, { transaction });
  if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');
  return person;
}

/**
 * recordConsent — registra um novo estado de opt-in/opt-out (CRMX-008: "Comunicação respeita
 * opt-in/opt-out e finalidade"). Cada chamada cria um novo registro (histórico append-only) em
 * vez de sobrescrever o anterior, para preservar a trilha de consentimento ao longo do tempo.
 */
async function recordConsent(personId, payload, actorUserId, transaction) {
  const person = await assertPersonExists(personId, transaction);
  const { channel, purpose, status } = payload;
  const normalizedChannel = String(channel || '').toUpperCase();
  const normalizedStatus = String(status || '').toUpperCase();
  if (!VALID_CHANNELS.includes(normalizedChannel)) {
    throw AppError.badRequest(`O campo "channel" deve ser um de: ${VALID_CHANNELS.join(', ')}.`, 'PERSON_CONSENT_VALIDATION');
  }
  if (!purpose) {
    throw AppError.badRequest('O campo "purpose" é obrigatório.', 'PERSON_CONSENT_VALIDATION');
  }
  if (!VALID_STATUSES.includes(normalizedStatus)) {
    throw AppError.badRequest(`O campo "status" deve ser um de: ${VALID_STATUSES.join(', ')}.`, 'PERSON_CONSENT_VALIDATION');
  }

  return CommunicationConsent.create(
    {
      groupId: person.groupId,
      companyId: person.companyId,
      personId,
      channel: normalizedChannel,
      purpose: String(purpose).toUpperCase(),
      status: normalizedStatus,
      recordedAt: new Date(),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
}

async function listConsents(personId, transaction) {
  await assertPersonExists(personId, transaction);
  return CommunicationConsent.findAll({ where: { personId }, order: [['recorded_at', 'DESC']], transaction });
}

module.exports = { recordConsent, listConsents, VALID_CHANNELS, VALID_STATUSES };
