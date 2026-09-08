'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const billingScheduleService = require('./billingSchedule.service');
const collectionCaseService = require('./collectionCase.service');
const rentAdjustmentService = require('./rentAdjustment.service');
const guaranteedRentService = require('./guaranteedRent.service');
const rentAdvanceService = require('./rentAdvance.service');
const utilitiesService = require('./utilities.service');
const closeoutService = require('./closeout.service');

function withTenant(req) {
  return { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
}

// --- Billing schedules ---
const generateBillingSchedule = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => billingScheduleService.generateBillingSchedule(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listBillingSchedules = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    billingScheduleService.listBillingSchedules(t, { contractId: req.query.contractId, status: req.query.status })
  );
  return success(res, { data: items });
});
const getBillingSchedule = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => billingScheduleService.getBillingSchedule(req.params.id, t));
  return success(res, { data: item });
});
const registerBillingSchedulePayment = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    billingScheduleService.registerPayment(req.params.id, req.body.amountPaid, req.auth.userId, t)
  );
  return success(res, { data: item });
});

// --- Collection cases ---
const openCollectionCase = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    collectionCaseService.openCollectionCase(req.body.billingScheduleId, Number(req.body.daysPastDue || 0), req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: item });
});
const listCollectionCases = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    collectionCaseService.listCollectionCases(t, { contractId: req.query.contractId, status: req.query.status })
  );
  return success(res, { data: items });
});
const getCollectionCase = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => collectionCaseService.getCollectionCase(req.params.id, t));
  return success(res, { data: item });
});
const createCollectionAgreement = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => collectionCaseService.createAgreement(req.params.id, req.body, req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});

// --- Rent adjustments ---
const requestRentAdjustment = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => rentAdjustmentService.requestRentAdjustment(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listRentAdjustments = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    rentAdjustmentService.listRentAdjustments(t, { contractId: req.query.contractId, status: req.query.status })
  );
  return success(res, { data: items });
});
const getRentAdjustment = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => rentAdjustmentService.getRentAdjustment(req.params.id, t));
  return success(res, { data: item });
});

// --- Guaranteed rent ---
const enrollGuaranteedRent = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => guaranteedRentService.enrollGuaranteedRent(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listGuaranteedRentContracts = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => guaranteedRentService.listGuaranteedRentContracts(t, { contractId: req.query.contractId }));
  return success(res, { data: items });
});
const getGuaranteedRentContract = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => guaranteedRentService.getGuaranteedRentContract(req.params.id, t));
  return success(res, { data: item });
});
const payGuaranteedRent = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => guaranteedRentService.payGuaranteedRent(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data: item });
});

// --- Rent advances ---
const requestRentAdvance = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => rentAdvanceService.requestRentAdvance(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listRentAdvances = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    rentAdvanceService.listRentAdvances(t, { contractId: req.query.contractId, status: req.query.status })
  );
  return success(res, { data: items });
});
const getRentAdvance = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => rentAdvanceService.getRentAdvance(req.params.id, t));
  return success(res, { data: item });
});
const proposeRentAdvance = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => rentAdvanceService.proposeRentAdvance(req.params.id, req.auth.userId, t));
  return success(res, { data: item });
});
const acceptRentAdvance = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => rentAdvanceService.acceptRentAdvance(req.params.id, req.auth.userId, t));
  return success(res, { data: item });
});
const payRentAdvance = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => rentAdvanceService.payRentAdvance(req.params.id, req.auth.userId, t));
  return success(res, { data: item });
});
const recoverRentAdvance = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    rentAdvanceService.recoverRentAdvance(req.params.id, req.body.amountRecovered, req.auth.userId, t)
  );
  return success(res, { data: item });
});

// --- Utilities ---
const createUtilityObligation = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => utilitiesService.createUtilityObligation(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listUtilityObligations = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    utilitiesService.listUtilityObligations(t, { contractId: req.query.contractId, status: req.query.status })
  );
  return success(res, { data: items });
});
const getUtilityObligation = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => utilitiesService.getUtilityObligation(req.params.id, t));
  return success(res, { data: item });
});
const createUtilityAccount = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => utilitiesService.createUtilityAccount(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const completeOwnershipTransfer = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => utilitiesService.completeOwnershipTransfer(req.params.id, req.auth.userId, t));
  return success(res, { data: item });
});
const recordUtilityPayment = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => utilitiesService.recordUtilityPayment(req.params.id, req.body, req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});

// --- Closeout ---
const checkCloseoutEligibility = catchAsync(async (req, res) => {
  const reasons = await req.withTenantTransaction((t) => closeoutService.checkCloseoutEligibility(req.params.contractId, t));
  return success(res, { data: { contractId: req.params.contractId, eligible: reasons.length === 0, reasons } });
});
const closeoutContract = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => closeoutService.closeoutContract(req.params.contractId, req.auth.userId, t));
  return success(res, { data: item });
});

module.exports = {
  generateBillingSchedule,
  listBillingSchedules,
  getBillingSchedule,
  registerBillingSchedulePayment,
  openCollectionCase,
  listCollectionCases,
  getCollectionCase,
  createCollectionAgreement,
  requestRentAdjustment,
  listRentAdjustments,
  getRentAdjustment,
  enrollGuaranteedRent,
  listGuaranteedRentContracts,
  getGuaranteedRentContract,
  payGuaranteedRent,
  requestRentAdvance,
  listRentAdvances,
  getRentAdvance,
  proposeRentAdvance,
  acceptRentAdvance,
  payRentAdvance,
  recoverRentAdvance,
  createUtilityObligation,
  listUtilityObligations,
  getUtilityObligation,
  createUtilityAccount,
  completeOwnershipTransfer,
  recordUtilityPayment,
  checkCloseoutEligibility,
  closeoutContract,
};
