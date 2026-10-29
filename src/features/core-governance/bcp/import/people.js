'use strict';

const { Person, PersonContact } = require('../../../../models');
const { createPerson } = require('../../../people/person.service');
const { findPotentialDuplicate } = require('../../../people/personDedup.service');
const { commandRejected } = require('../bcp.errors');
const normalize = require('./normalize');

/**
 * Pessoa citada no papel (M9-D832): procura pelo documento (CPF/CNPJ) e, na falta, pelo telefone principal; se não existe, cadastra pelo serviço normal de pessoas
 * (nunca insere direto). Devolve `{ person, created }`; `created` diz se esta importação criou a pessoa (o estorno a remove só nesse caso).
 */
async function findOrCreatePerson({ tenant, actorUserId, name, phone, email, document }, transaction) {
  const taxId = normalize.digits(document);
  const phoneDigits = normalize.digits(phone);
  const contacts = [];
  if (phoneDigits) contacts.push({ contactType: 'PHONE', valueNormalized: phoneDigits, isPrimary: true });
  if (email) contacts.push({ contactType: 'EMAIL', valueNormalized: String(email).trim().toLowerCase(), isPrimary: false });
  const existing = await findPotentialDuplicate({ taxIdNormalized: taxId || null, contacts: contacts.filter((c) => c.contactType === 'PHONE') }, transaction);
  if (existing) return { person: existing, created: false };
  const person = await createPerson({
    groupId: tenant.groupId, companyId: tenant.companyId, personType: taxId.length === 14 ? 'PJ' : 'PF', legalName: String(name).trim(), taxIdNormalized: taxId || null, contacts, allowDuplicate: false,
  }, actorUserId, transaction);
  return { person, created: true };
}

/** Pessoa que já deve existir (ex.: quem recebe as chaves tem de ser parte do contrato): só procura pelo documento. */
async function findPersonByDocument(document, transaction) {
  const taxId = normalize.digits(document);
  const person = taxId ? await Person.findOne({ where: { taxIdNormalized: taxId }, transaction }) : null;
  if (!person) throw commandRejected(`não há pessoa cadastrada com o documento ${taxId || 'informado'}`);
  return person;
}

/** Telefone principal (só dígitos) da pessoa, lido do cadastro. */
async function primaryPhoneOf(personId, transaction) {
  const contact = await PersonContact.findOne({ where: { personId, contactType: 'PHONE' }, order: [['isPrimary', 'DESC'], ['created_at', 'ASC']], transaction });
  return contact ? normalize.digits(contact.valueNormalized) : '';
}

module.exports = { findOrCreatePerson, findPersonByDocument, primaryPhoneOf };
