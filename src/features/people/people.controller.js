'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const peopleService = require('./person.service');
const contactsService = require('./personContacts.service');
const documentsService = require('./personDocuments.service');
const rolesService = require('./personRoles.service');
const addressesService = require('./personAddresses.service');
const consentsService = require('./personConsents.service');
const mergeService = require('./personMerge.service');
const dedupService = require('./personDedup.service');

// --- Persons ---

const create = catchAsync(async (req, res) => {
  const payload = { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
  const person = await req.withTenantTransaction((transaction) =>
    peopleService.createPerson(payload, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: person });
});

const list = catchAsync(async (req, res) => {
  const persons = await req.withTenantTransaction((transaction) =>
    // O service filtra por `personType` (o nome do campo no model) — passar `type` aqui fazia o
    // filtro de PF/PJ ser silenciosamente ignorado. Aceita os dois nomes na query string.
    peopleService.listPersons(transaction, {
      personType: req.query.personType || req.query.type,
      status: req.query.status,
    })
  );
  return success(res, { data: persons });
});

const listDuplicates = catchAsync(async (req, res) => {
  const pairs = await req.withTenantTransaction((transaction) => dedupService.listPotentialDuplicatePairs(transaction));
  return success(res, { data: pairs });
});

const getOne = catchAsync(async (req, res) => {
  const person = await req.withTenantTransaction((transaction) => peopleService.getPerson(req.params.id, transaction));
  return success(res, { data: person });
});

const update = catchAsync(async (req, res) => {
  const person = await req.withTenantTransaction((transaction) =>
    peopleService.updatePerson(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { data: person });
});

const remove = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) =>
    peopleService.deletePerson(req.params.id, req.auth.userId, transaction)
  );
  return success(res, { data: result });
});

// --- Contacts ---

const createContact = catchAsync(async (req, res) => {
  const contact = await req.withTenantTransaction((transaction) =>
    contactsService.createContact(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: contact });
});

const listContacts = catchAsync(async (req, res) => {
  const contacts = await req.withTenantTransaction((transaction) => contactsService.listContacts(req.params.id, transaction));
  return success(res, { data: contacts });
});

const updateContact = catchAsync(async (req, res) => {
  const contact = await req.withTenantTransaction((transaction) =>
    contactsService.updateContact(req.params.id, req.params.contactId, req.body, req.auth.userId, transaction)
  );
  return success(res, { data: contact });
});

const removeContact = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) =>
    contactsService.deleteContact(req.params.id, req.params.contactId, req.auth.userId, transaction)
  );
  return success(res, { data: result });
});

// --- Documents ---

const createDocument = catchAsync(async (req, res) => {
  const document = await req.withTenantTransaction((transaction) =>
    documentsService.createDocument(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: document });
});

const listDocuments = catchAsync(async (req, res) => {
  const documents = await req.withTenantTransaction((transaction) => documentsService.listDocuments(req.params.id, transaction));
  return success(res, { data: documents });
});

const updateDocument = catchAsync(async (req, res) => {
  const document = await req.withTenantTransaction((transaction) =>
    documentsService.updateDocument(req.params.id, req.params.documentId, req.body, req.auth.userId, transaction)
  );
  return success(res, { data: document });
});

const removeDocument = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) =>
    documentsService.deleteDocument(req.params.id, req.params.documentId, req.auth.userId, transaction)
  );
  return success(res, { data: result });
});

// --- Roles ---

const createRole = catchAsync(async (req, res) => {
  const role = await req.withTenantTransaction((transaction) =>
    rolesService.createRole(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: role });
});

const listRoles = catchAsync(async (req, res) => {
  const roles = await req.withTenantTransaction((transaction) => rolesService.listRoles(req.params.id, transaction));
  return success(res, { data: roles });
});

const updateRole = catchAsync(async (req, res) => {
  const role = await req.withTenantTransaction((transaction) =>
    rolesService.updateRole(req.params.id, req.params.roleId, req.body, req.auth.userId, transaction)
  );
  return success(res, { data: role });
});

const removeRole = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) =>
    rolesService.deleteRole(req.params.id, req.params.roleId, req.auth.userId, transaction)
  );
  return success(res, { data: result });
});

// --- Addresses ---

const createAddress = catchAsync(async (req, res) => {
  const address = await req.withTenantTransaction((transaction) =>
    addressesService.createAddress(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: address });
});

const listAddresses = catchAsync(async (req, res) => {
  const addresses = await req.withTenantTransaction((transaction) => addressesService.listAddresses(req.params.id, transaction));
  return success(res, { data: addresses });
});

// --- Communication consents ---

const createConsent = catchAsync(async (req, res) => {
  const consent = await req.withTenantTransaction((transaction) =>
    consentsService.recordConsent(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: consent });
});

const listConsents = catchAsync(async (req, res) => {
  const consents = await req.withTenantTransaction((transaction) => consentsService.listConsents(req.params.id, transaction));
  return success(res, { data: consents });
});

// --- Merge ---

const merge = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) =>
    mergeService.mergePersons(req.params.id, req.body.absorbedId, req.auth.userId, transaction)
  );
  return success(res, { data: result });
});

module.exports = {
  create,
  list,
  listDuplicates,
  getOne,
  update,
  remove,
  createContact,
  listContacts,
  updateContact,
  removeContact,
  createDocument,
  listDocuments,
  updateDocument,
  removeDocument,
  createRole,
  listRoles,
  updateRole,
  removeRole,
  createAddress,
  listAddresses,
  createConsent,
  listConsents,
  merge,
};
