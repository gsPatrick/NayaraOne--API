'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const billingController = require('./billing.controller');

const billingRouter = Router();

billingRouter.use(authMiddleware, tenantMiddleware);

// Billing schedules
billingRouter.post('/billing/schedules', requirePermission('billing:create'), billingController.generateBillingSchedule);
billingRouter.get('/billing/schedules', requirePermission('billing:read'), billingController.listBillingSchedules);
billingRouter.get('/billing/schedules/:id', requirePermission('billing:read'), billingController.getBillingSchedule);
billingRouter.post('/billing/schedules/:id/payments', requirePermission('billing:update'), billingController.registerBillingSchedulePayment);

// Collection cases
billingRouter.post('/billing/collection-cases', requirePermission('billing:create'), billingController.openCollectionCase);
billingRouter.get('/billing/collection-cases', requirePermission('billing:read'), billingController.listCollectionCases);
billingRouter.get('/billing/collection-cases/:id', requirePermission('billing:read'), billingController.getCollectionCase);
billingRouter.post('/billing/collection-cases/:id/agreements', requirePermission('billing:update'), billingController.createCollectionAgreement);

// Rent adjustments
billingRouter.post('/billing/rent-adjustments', requirePermission('billing:create'), billingController.requestRentAdjustment);
billingRouter.get('/billing/rent-adjustments', requirePermission('billing:read'), billingController.listRentAdjustments);
billingRouter.get('/billing/rent-adjustments/:id', requirePermission('billing:read'), billingController.getRentAdjustment);

// Guaranteed rent
billingRouter.post('/billing/guaranteed-rent', requirePermission('billing:create'), billingController.enrollGuaranteedRent);
billingRouter.get('/billing/guaranteed-rent', requirePermission('billing:read'), billingController.listGuaranteedRentContracts);
billingRouter.get('/billing/guaranteed-rent/:id', requirePermission('billing:read'), billingController.getGuaranteedRentContract);
billingRouter.post('/billing/guaranteed-rent/:id/pay', requirePermission('billing:approve'), billingController.payGuaranteedRent);

// Rent advances
billingRouter.post('/billing/rent-advances', requirePermission('billing:create'), billingController.requestRentAdvance);
billingRouter.get('/billing/rent-advances', requirePermission('billing:read'), billingController.listRentAdvances);
billingRouter.get('/billing/rent-advances/:id', requirePermission('billing:read'), billingController.getRentAdvance);
billingRouter.post('/billing/rent-advances/:id/propose', requirePermission('billing:update'), billingController.proposeRentAdvance);
billingRouter.post('/billing/rent-advances/:id/accept', requirePermission('billing:approve'), billingController.acceptRentAdvance);
billingRouter.post('/billing/rent-advances/:id/pay', requirePermission('billing:approve'), billingController.payRentAdvance);
billingRouter.post('/billing/rent-advances/:id/recover', requirePermission('billing:update'), billingController.recoverRentAdvance);

// Utilities
billingRouter.post('/billing/utility-obligations', requirePermission('billing:create'), billingController.createUtilityObligation);
billingRouter.get('/billing/utility-obligations', requirePermission('billing:read'), billingController.listUtilityObligations);
billingRouter.get('/billing/utility-obligations/:id', requirePermission('billing:read'), billingController.getUtilityObligation);
billingRouter.post('/billing/utility-accounts', requirePermission('billing:create'), billingController.createUtilityAccount);
billingRouter.post('/billing/utility-obligations/:id/payments', requirePermission('billing:update'), billingController.recordUtilityPayment);
billingRouter.post('/billing/ownership-transfer-tasks/:id/complete', requirePermission('billing:update'), billingController.completeOwnershipTransfer);

// Closeout
billingRouter.get('/billing/contracts/:contractId/closeout-eligibility', requirePermission('billing:read'), billingController.checkCloseoutEligibility);
billingRouter.post('/billing/contracts/:contractId/closeout', requirePermission('billing:update'), billingController.closeoutContract);

module.exports = billingRouter;
