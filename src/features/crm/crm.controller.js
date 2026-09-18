'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const opportunitiesService = require('./opportunity.service');
const visitsService = require('./visits.service');
const messagesService = require('./messages.service');
const proposalsService = require('./proposals.service');
const dashboardService = require('./dashboard.service');
const feedbackCasesService = require('./feedbackCases.service');
const opportunitiesExportService = require('./opportunitiesExport.service');
const opportunityTasksService = require('./opportunityTasks.service');
const opportunityTimelineService = require('./opportunityTimeline.service');

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

// --- Tarefas da oportunidade (M3-11) ---

const createOpportunityTask = catchAsync(async (req, res) => {
  const task = await req.withTenantTransaction((transaction) =>
    opportunityTasksService.createOpportunityTask(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: task });
});

const listOpportunityTasks = catchAsync(async (req, res) => {
  const tasks = await req.withTenantTransaction((transaction) =>
    opportunityTasksService.listOpportunityTasks(req.params.id, transaction, {
      status: req.query.status,
      assignedToUserId: req.query.assignedToUserId,
    })
  );
  return success(res, { data: tasks });
});

// --- Timeline omnichannel unificada (M3-19) ---

const getOpportunityTimeline = catchAsync(async (req, res) => {
  const timeline = await req.withTenantTransaction((transaction) =>
    opportunityTimelineService.getOpportunityTimeline(req.params.id, transaction, {
      types: req.query.types ? String(req.query.types).split(',') : undefined,
    })
  );
  return success(res, { data: timeline });
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

// --- Proposals (M3-13 / M3-25) ---

const createProposal = catchAsync(async (req, res) => {
  const payload = { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
  const proposal = await req.withTenantTransaction((transaction) =>
    proposalsService.createProposal(payload, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: proposal });
});

const listProposals = catchAsync(async (req, res) => {
  const proposals = await req.withTenantTransaction((transaction) =>
    proposalsService.listProposals(transaction, {
      opportunityId: req.query.opportunityId,
      propertyId: req.query.propertyId,
      status: req.query.status,
    })
  );
  return success(res, { data: proposals });
});

const getProposal = catchAsync(async (req, res) => {
  const proposal = await req.withTenantTransaction((transaction) =>
    proposalsService.getProposal(req.params.id, transaction)
  );
  return success(res, { data: proposal });
});

const updateProposalStatus = catchAsync(async (req, res) => {
  const proposal = await req.withTenantTransaction((transaction) =>
    proposalsService.updateProposalStatus(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { data: proposal });
});

// --- Dashboard (M3-17) ---

const getDashboard = catchAsync(async (req, res) => {
  const dashboard = await req.withTenantTransaction((transaction) =>
    dashboardService.getCrmDashboard(
      {
        ownerUserId: req.query.ownerUserId,
        personId: req.query.personId,
        propertyId: req.query.propertyId,
        createdFrom: req.query.createdFrom,
        createdTo: req.query.createdTo,
      },
      transaction
    )
  );
  return success(res, { data: dashboard });
});

// --- Feedback cases: reclamações, elogios e conflitos (M3-20) ---

const createFeedbackCase = catchAsync(async (req, res) => {
  const payload = { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
  const feedbackCase = await req.withTenantTransaction((transaction) =>
    feedbackCasesService.createFeedbackCase(payload, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: feedbackCase });
});

const listFeedbackCases = catchAsync(async (req, res) => {
  const cases = await req.withTenantTransaction((transaction) =>
    feedbackCasesService.listFeedbackCases(transaction, {
      status: req.query.status,
      type: req.query.type,
      severity: req.query.severity,
      personId: req.query.personId,
      assignedToUserId: req.query.assignedToUserId,
      overdue: req.query.overdue === 'true',
    })
  );
  return success(res, { data: cases });
});

const getFeedbackCase = catchAsync(async (req, res) => {
  const feedbackCase = await req.withTenantTransaction((transaction) =>
    feedbackCasesService.getFeedbackCase(req.params.id, transaction)
  );
  return success(res, { data: feedbackCase });
});

const resolveFeedbackCase = catchAsync(async (req, res) => {
  const feedbackCase = await req.withTenantTransaction((transaction) =>
    feedbackCasesService.resolveFeedbackCase(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { data: feedbackCase });
});

const escalateFeedbackCase = catchAsync(async (req, res) => {
  const feedbackCase = await req.withTenantTransaction((transaction) =>
    feedbackCasesService.escalateFeedbackCase(req.params.id, { automatic: false }, req.auth.userId, transaction)
  );
  return success(res, { data: feedbackCase });
});

// --- Exportação sensível (M3-21) ---

const exportOpportunities = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) =>
    opportunitiesExportService.exportOpportunities(
      {
        groupId: req.auth.groupId,
        companyId: req.auth.companyId,
        actorUserId: req.auth.userId,
        actorPermissions: req.auth.permissions,
        format: req.query.format,
        filters: { stage: req.query.stage, personId: req.query.personId, propertyId: req.query.propertyId },
      },
      transaction
    )
  );

  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
  res.setHeader('X-Export-Record-Count', String(result.recordCount));
  return res.status(200).send(result.content);
});

module.exports = {
  createOpportunity,
  listOpportunities,
  getOpportunity,
  updateOpportunity,
  removeOpportunity,
  createOpportunityTask,
  listOpportunityTasks,
  getOpportunityTimeline,
  createVisit,
  listVisits,
  getVisit,
  updateVisit,
  removeVisit,
  createMessage,
  listMessages,
  getMessage,
  updateMessageStatus,
  createProposal,
  listProposals,
  getProposal,
  updateProposalStatus,
  getDashboard,
  createFeedbackCase,
  listFeedbackCases,
  getFeedbackCase,
  resolveFeedbackCase,
  escalateFeedbackCase,
  exportOpportunities,
};
