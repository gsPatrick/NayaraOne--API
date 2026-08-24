'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const propertiesService = require('./properties.service');
const ownersService = require('./propertyOwners.service');
const offersService = require('./propertyOffers.service');
const occurrencesService = require('./propertyInternalOccurrences.service');
const publishService = require('./publish.service');

// --- Properties ---

const create = catchAsync(async (req, res) => {
  const payload = { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
  const property = await req.withTenantTransaction((transaction) =>
    propertiesService.createProperty(payload, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: property });
});

const list = catchAsync(async (req, res) => {
  const properties = await req.withTenantTransaction((transaction) =>
    propertiesService.listProperties(transaction, {
      propertyType: req.query.propertyType,
      status: req.query.status,
      city: req.query.city,
    })
  );
  return success(res, { data: properties });
});

const getOne = catchAsync(async (req, res) => {
  const property = await req.withTenantTransaction((transaction) => propertiesService.getProperty(req.params.id, transaction));
  return success(res, { data: property });
});

const update = catchAsync(async (req, res) => {
  const property = await req.withTenantTransaction((transaction) =>
    propertiesService.updateProperty(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { data: property });
});

const remove = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) =>
    propertiesService.deleteProperty(req.params.id, req.auth.userId, transaction)
  );
  return success(res, { data: result });
});

// --- Owners ---

const createOwner = catchAsync(async (req, res) => {
  const owner = await req.withTenantTransaction((transaction) =>
    ownersService.createOwner(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: owner });
});

const listOwners = catchAsync(async (req, res) => {
  const owners = await req.withTenantTransaction((transaction) => ownersService.listOwners(req.params.id, transaction));
  return success(res, { data: owners });
});

const updateOwner = catchAsync(async (req, res) => {
  const owner = await req.withTenantTransaction((transaction) =>
    ownersService.updateOwner(req.params.id, req.params.ownerId, req.body, req.auth.userId, transaction)
  );
  return success(res, { data: owner });
});

const removeOwner = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) =>
    ownersService.deleteOwner(req.params.id, req.params.ownerId, req.auth.userId, transaction)
  );
  return success(res, { data: result });
});

// --- Offers ---

const createOffer = catchAsync(async (req, res) => {
  const offer = await req.withTenantTransaction((transaction) =>
    offersService.createOffer(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: offer });
});

const listOffers = catchAsync(async (req, res) => {
  const offers = await req.withTenantTransaction((transaction) =>
    offersService.listOffers(req.params.id, transaction, { status: req.query.status, offerType: req.query.offerType })
  );
  return success(res, { data: offers });
});

const updateOffer = catchAsync(async (req, res) => {
  const offer = await req.withTenantTransaction((transaction) =>
    offersService.updateOffer(req.params.id, req.params.offerId, req.body, req.auth.userId, transaction)
  );
  return success(res, { data: offer });
});

// --- Internal occurrences (nunca expostas em rota pública) ---

const createOccurrence = catchAsync(async (req, res) => {
  const occurrence = await req.withTenantTransaction((transaction) =>
    occurrencesService.createOccurrence(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: occurrence });
});

const listOccurrences = catchAsync(async (req, res) => {
  const occurrences = await req.withTenantTransaction((transaction) => occurrencesService.listOccurrences(req.params.id, transaction));
  return success(res, { data: occurrences });
});

// --- Publish ---

const publishOffer = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) =>
    publishService.publishOffer(req.params.id, req.auth, req.auth.userId, transaction)
  );
  return success(res, { data: result });
});

module.exports = {
  create,
  list,
  getOne,
  update,
  remove,
  createOwner,
  listOwners,
  updateOwner,
  removeOwner,
  createOffer,
  listOffers,
  updateOffer,
  createOccurrence,
  listOccurrences,
  publishOffer,
};
