'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const opportunitiesService = require('./opportunity.service');
const visitsService = require('./visits.service');
const messagesService = require('./messages.service');

// --- Opportunities ---

const createOpportunity = catchAsync(async (req, res) => {
  const payload = { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
  const opportunity = await req.withTenantTransaction((transaction) =>
    opportunitiesService.createOpportunity(payload, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: opportunity });
});

const listOpportunities = catchAsync(async (req, res) => {
  const opportunities = await req.withTenantTransaction((transaction) =>
    opportunitiesService.listOpportunities(transaction, {
      stage: req.query.stage,
      personId: req.query.personId,
      propertyId: req.query.propertyId,
    })
  );
  return success(res, { data: opportunities });
});

const getOpportunity = catchAsync(async (req, res) => {
  const opportunity = await req.withTenantTransaction((transaction) =>
    opportunitiesService.getOpportunity(req.params.id, transaction)
  );
  return success(res, { data: opportunity });
});

const updateOpportunity = catchAsync(async (req, res) => {
  const opportunity = await req.withTenantTransaction((transaction) =>
    opportunitiesService.updateOpportunity(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { data: opportunity });
});

const removeOpportunity = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) =>
    opportunitiesService.deleteOpportunity(req.params.id, req.auth.userId, transaction)
  );
  return success(res, { data: result });
});

// --- Visits ---

const createVisit = catchAsync(async (req, res) => {
  const payload = { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
  const visit = await req.withTenantTransaction((transaction) => visitsService.createVisit(payload, req.auth.userId, transaction));
  return success(res, { statusCode: 201, data: visit });
});

const listVisits = catchAsync(async (req, res) => {
  const visits = await req.withTenantTransaction((transaction) =>
    visitsService.listVisits(transaction, {
      propertyId: req.query.propertyId,
      opportunityId: req.query.opportunityId,
      personId: req.query.personId,
      status: req.query.status,
    })
  );
  return success(res, { data: visits });
});

const getVisit = catchAsync(async (req, res) => {
  const visit = await req.withTenantTransaction((transaction) => visitsService.getVisit(req.params.id, transaction));
  return success(res, { data: visit });
});

const updateVisit = catchAsync(async (req, res) => {
  const visit = await req.withTenantTransaction((transaction) =>
    visitsService.updateVisit(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { data: visit });
});

const removeVisit = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) =>
    visitsService.deleteVisit(req.params.id, req.auth.userId, transaction)
  );
  return success(res, { data: result });
});

// --- Messages ---

const createMessage = catchAsync(async (req, res) => {
  const payload = { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
  const message = await req.withTenantTransaction((transaction) =>
    messagesService.createMessage(payload, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: message });
});

const listMessages = catchAsync(async (req, res) => {
  const messages = await req.withTenantTransaction((transaction) =>
    messagesService.listMessages(transaction, { personId: req.query.personId, opportunityId: req.query.opportunityId })
  );
  return success(res, { data: messages });
});

const getMessage = catchAsync(async (req, res) => {
  const message = await req.withTenantTransaction((transaction) => messagesService.getMessage(req.params.id, transaction));
  return success(res, { data: message });
});

const updateMessageStatus = catchAsync(async (req, res) => {
  const message = await req.withTenantTransaction((transaction) =>
    messagesService.updateMessageStatus(req.params.id, req.body.status, req.auth.userId, transaction)
  );
  return success(res, { data: message });
});

module.exports = {
  createOpportunity,
  listOpportunities,
  getOpportunity,
  updateOpportunity,
  removeOpportunity,
  createVisit,
  listVisits,
  getVisit,
  updateVisit,
  removeVisit,
  createMessage,
  listMessages,
  getMessage,
  updateMessageStatus,
};
