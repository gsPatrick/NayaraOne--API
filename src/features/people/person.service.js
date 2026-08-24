'use strict';

const { Person, PersonContact, PersonDocument } = require('../../models');
const AppError = require('../../utils/AppError');
const { onlyDigits, validateDocumentFormat, hashTaxId } = require('./personDocumentFormat.service');
const { findPotentialDuplicate } = require('./personDedup.service');
const { publishPersonCreated } = require('./personEvents.service');

/**
 * CRUD puro de Person (mais a criação inicial de seus contacts/documents embutidos no payload
 * de criação). Deduplicação vive em personDedup.service.js; validação de formato de documento
 * vive em personDocumentFormat.service.js; contacts/documents/roles como sub-recursos têm CRUD
 * próprio em personContacts.service.js / personDocuments.service.js / personRoles.service.js.
 *
 * "people"."persons" tem RLS por par de policies (persons_company_select/persons_company_write —
 * ver migration 20260101000083); "person_contacts"/"person_documents" têm RLS por
 * `company_id = current_setting('app.company_id', true)`. Toda query aqui recebe `transaction`
 * já aberta por `req.withTenantTransaction` (ver src/middlewares/tenant.middleware.js).
 */

async function createPerson(payload, actorUserId, transaction) {
  const { groupId, companyId, personType, legalName, taxIdNormalized, birthOrFoundationDate, status, contacts, documents, allowDuplicate } =
    payload;

  if (!groupId || !companyId || !legalName) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "legalName" são obrigatórios.', 'PERSON_VALIDATION');
  }

  const normalizedType = (personType || 'PF').toUpperCase();
  if (!['PF', 'PJ'].includes(normalizedType)) {
    throw AppError.badRequest('O campo "personType" deve ser "PF" ou "PJ".', 'PERSON_VALIDATION');
  }

  const taxIdDigits = onlyDigits(taxIdNormalized) || null;
  if (taxIdDigits) {
    validateDocumentFormat(normalizedType === 'PF' ? 'CPF' : 'CNPJ', taxIdDigits);
  }

  if (!allowDuplicate) {
    const duplicate = await findPotentialDuplicate({ taxIdNormalized: taxIdDigits, contacts }, transaction);
    if (duplicate) {
      throw AppError.conflict(
        'Já existe uma pessoa cadastrada com o mesmo documento ou contato principal. Envie "allowDuplicate": true para criar mesmo assim.',
        'PERSON_DUPLICATE',
        { existingPersonId: duplicate.id }
      );
    }
  }

  let person;
  try {
    person = await Person.create(
      {
        groupId,
        companyId,
        personType: normalizedType,
        legalName,
        preferredName: payload.preferredName || null,
        taxIdNormalized: taxIdDigits,
        taxIdNormalizedHash: hashTaxId(taxIdDigits),
        birthOrFoundationDate: birthOrFoundationDate || null,
        status: status || 'ACTIVE',
        riskFlagsJson: payload.riskFlagsJson || null,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  } catch (error) {
    // UNIQUE(group_id, tax_id_normalized) é uma constraint de identidade rígida do banco
    // (TAB-0100) — diferente do match "médio/fraco" de findPotentialDuplicate, ela NÃO pode
    // ser contornada por "allowDuplicate": duas pessoas com o mesmo CPF/CNPJ no mesmo grupo
    // nunca são uma duplicata legítima de negócio, são o mesmo documento.
    if (error.name === 'SequelizeUniqueConstraintError' && /tax_id_normalized/.test(error.parent?.detail || error.parent?.message || '')) {
      throw AppError.conflict(
        'Já existe uma pessoa com este documento (CPF/CNPJ) neste grupo. Esta duplicidade é uma restrição de identidade e não pode ser forçada com "allowDuplicate".',
        'PERSON_DUPLICATE_TAX_ID'
      );
    }
    throw error;
  }

  await publishPersonCreated(person, transaction);

  if (Array.isArray(contacts)) {
    for (const contact of contacts) {
      const contactType = contact.contactType || contact.channel;
      const valueNormalized = contact.valueNormalized || contact.value;
      if (!contactType || !valueNormalized) continue;
      await PersonContact.create(
        {
          groupId,
          companyId,
          personId: person.id,
          contactType: String(contactType).toUpperCase(),
          valueNormalized,
          isPrimary: !!contact.isPrimary,
          createdBy: actorUserId || null,
          updatedBy: actorUserId || null,
        },
        { transaction }
      );
    }
  }

  if (Array.isArray(documents)) {
    for (const document of documents) {
      if (!document.documentType || !document.fileId) continue;
      await PersonDocument.create(
        {
          groupId,
          companyId,
          personId: person.id,
          documentType: String(document.documentType).toUpperCase(),
          fileId: document.fileId,
          versionNo: document.versionNo || 1,
          issuedAt: document.issuedAt || null,
          expiresAt: document.expiresAt || null,
          verificationStatus: document.verificationStatus || 'PENDING',
          createdBy: actorUserId || null,
          updatedBy: actorUserId || null,
        },
        { transaction }
      );
    }
  }

  return getPerson(person.id, transaction);
}

async function listPersons(transaction, filters = {}) {
  const where = {};
  if (filters.personType) where.personType = String(filters.personType).toUpperCase();
  if (filters.status) where.status = filters.status;
  return Person.findAll({
    where,
    include: [
      { model: PersonContact, as: 'contacts' },
      { model: PersonDocument, as: 'documents' },
    ],
    order: [['created_at', 'DESC']],
    transaction,
  });
}

async function getPerson(id, transaction) {
  const person = await Person.findByPk(id, {
    include: [
      { model: PersonContact, as: 'contacts' },
      { model: PersonDocument, as: 'documents' },
    ],
    transaction,
  });
  if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');
  return person;
}

async function updatePerson(id, payload, actorUserId, transaction) {
  const person = await Person.findByPk(id, { transaction });
  if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');

  const { legalName, preferredName, taxIdNormalized, birthOrFoundationDate, status, personType, riskFlagsJson } = payload;
  if (legalName !== undefined) person.legalName = legalName;
  if (preferredName !== undefined) person.preferredName = preferredName;
  if (personType !== undefined) {
    const normalizedType = String(personType).toUpperCase();
    if (!['PF', 'PJ'].includes(normalizedType)) {
      throw AppError.badRequest('O campo "personType" deve ser "PF" ou "PJ".', 'PERSON_VALIDATION');
    }
    person.personType = normalizedType;
  }
  if (taxIdNormalized !== undefined) {
    const taxIdDigits = onlyDigits(taxIdNormalized) || null;
    if (taxIdDigits) validateDocumentFormat(person.personType === 'PF' ? 'CPF' : 'CNPJ', taxIdDigits);
    person.taxIdNormalized = taxIdDigits;
    person.taxIdNormalizedHash = hashTaxId(taxIdDigits);
  }
  if (birthOrFoundationDate !== undefined) person.birthOrFoundationDate = birthOrFoundationDate;
  if (status !== undefined) person.status = status;
  if (riskFlagsJson !== undefined) person.riskFlagsJson = riskFlagsJson;
  person.updatedBy = actorUserId || null;
  await person.save({ transaction });
  return getPerson(id, transaction);
}

async function deletePerson(id, actorUserId, transaction) {
  const person = await Person.findByPk(id, { transaction });
  if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');
  person.deletedBy = actorUserId || null;
  await person.save({ transaction });
  await person.destroy({ transaction }); // soft delete (paranoid: true no model)
  return { id };
}

module.exports = { createPerson, listPersons, getPerson, updatePerson, deletePerson };
