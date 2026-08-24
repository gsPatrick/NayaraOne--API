'use strict';

const { PersonContact, Person } = require('../../models');
const AppError = require('../../utils/AppError');

// Enum FECHADO confirmado pelo Caderno para person_contacts.contact_type.
const VALID_CONTACT_TYPES = ['PHONE', 'WHATSAPP', 'EMAIL'];

async function assertPersonExists(personId, transaction) {
  const person = await Person.findByPk(personId, { transaction });
  if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');
  return person;
}

function assertValidContactType(contactType) {
  if (!VALID_CONTACT_TYPES.includes(contactType)) {
    throw AppError.badRequest(
      `O campo "contactType" deve ser um de: ${VALID_CONTACT_TYPES.join(', ')}.`,
      'PERSON_CONTACT_VALIDATION'
    );
  }
}

async function createContact(personId, payload, actorUserId, transaction) {
  const person = await assertPersonExists(personId, transaction);
  const { contactType, valueNormalized, isPrimary, consentStatus } = payload;
  if (!contactType || !valueNormalized) {
    throw AppError.badRequest('Os campos "contactType" e "valueNormalized" são obrigatórios.', 'PERSON_CONTACT_VALIDATION');
  }
  const normalizedType = String(contactType).toUpperCase();
  assertValidContactType(normalizedType);
  return PersonContact.create(
    {
      groupId: person.groupId,
      companyId: person.companyId,
      personId,
      contactType: normalizedType,
      valueNormalized,
      isPrimary: !!isPrimary,
      consentStatus: consentStatus || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
}

async function listContacts(personId, transaction) {
  await assertPersonExists(personId, transaction);
  return PersonContact.findAll({ where: { personId }, order: [['created_at', 'DESC']], transaction });
}

async function getContact(personId, contactId, transaction) {
  const contact = await PersonContact.findOne({ where: { id: contactId, personId }, transaction });
  if (!contact) throw AppError.notFound('Contato não encontrado.', 'PERSON_CONTACT_NOT_FOUND');
  return contact;
}

async function updateContact(personId, contactId, payload, actorUserId, transaction) {
  const contact = await getContact(personId, contactId, transaction);
  const { contactType, valueNormalized, isPrimary, consentStatus, verifiedAt } = payload;
  if (contactType !== undefined) {
    const normalizedType = String(contactType).toUpperCase();
    assertValidContactType(normalizedType);
    contact.contactType = normalizedType;
  }
  if (valueNormalized !== undefined) contact.valueNormalized = valueNormalized;
  if (isPrimary !== undefined) contact.isPrimary = !!isPrimary;
  if (consentStatus !== undefined) contact.consentStatus = consentStatus;
  if (verifiedAt !== undefined) contact.verifiedAt = verifiedAt;
  contact.updatedBy = actorUserId || null;
  await contact.save({ transaction });
  return contact;
}

async function deleteContact(personId, contactId, actorUserId, transaction) {
  const contact = await getContact(personId, contactId, transaction);
  contact.deletedBy = actorUserId || null;
  await contact.save({ transaction });
  await contact.destroy({ transaction });
  return { id: contactId };
}

module.exports = { createContact, listContacts, getContact, updateContact, deleteContact, VALID_CONTACT_TYPES };
