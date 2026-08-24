'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const propertiesService = require('./properties.service');
const ownersService = require('./propertyOwners.service');
const offersService = require('./propertyOffers.service');
const occurrencesService = require('./propertyInternalOccurrences.service');
const mediaService = require('./propertyMedia.service');
const documentsService = require('./propertyDocuments.service');
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
      // O service filtra por publicationStatus/availabilityStatus (as duas colunas que
      // substituíram a antiga "status") — mandar `status`/`city` aqui fazia o filtro ser
      // silenciosamente ignorado.
      propertyType: req.query.propertyType,
      publicationStatus: req.query.publicationStatus,
      availabilityStatus: req.query.availabilityStatus,
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

// --- Media ---

const createMedia = catchAsync(async (req, res) => {
  const media = await req.withTenantTransaction((transaction) =>
    mediaService.createMedia(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: media });
});

const listMedia = catchAsync(async (req, res) => {
  const media = await req.withTenantTransaction((transaction) => mediaService.listMedia(req.params.id, transaction));
  return success(res, { data: media });
});

const removeMedia = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) =>
    mediaService.deleteMedia(req.params.id, req.params.mediaId, transaction)
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
  const documents = await req.withTenantTransaction((transaction) =>
    documentsService.listDocuments(req.params.id, transaction)
  );
  return success(res, { data: documents });
});

const removeDocument = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) =>
    documentsService.deleteDocument(req.params.id, req.params.documentId, transaction)
  );
  return success(res, { data: result });
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
  createMedia,
  listMedia,
  removeMedia,
  createDocument,
  listDocuments,
  removeDocument,
  publishOffer,
};
