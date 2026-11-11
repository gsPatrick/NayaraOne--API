'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const billingController = require('./billing.controller');
const obligationCyclesController = require('./obligations/obligationCycles.controller');
require('./keysDeliveredObligations.consumer'); // Fechamento M5: keys.delivered inicia as obrigações da locação
// Fechamento M5 (bloco "Correções pós-auditoria — DoD: idempotência"): toda criação/ação POST da cobrança aceita
// `Idempotency-Key` (padrão de API M9-D843): repetir a chamada com a mesma chave devolve a resposta original sem
// repetir o efeito (ex.: pagamento de utilidade não gera um segundo reembolso/recebível).
const { idempotency, replayErrorHandler } = require('../core-governance/api-governance/standards/idempotency.middleware');

const billingRouter = Router();

billingRouter.use(authMiddleware, tenantMiddleware);

// Billing schedules
billingRouter.post('/billing/schedules', requirePermission('billing:create'), idempotency(), billingController.generateBillingSchedule);
billingRouter.get('/billing/schedules', requirePermission('billing:read'), billingController.listBillingSchedules);
billingRouter.get('/billing/schedules/:id', requirePermission('billing:read'), billingController.getBillingSchedule);
billingRouter.post('/billing/schedules/:id/payments', requirePermission('billing:update'), idempotency(), billingController.registerBillingSchedulePayment);

// Collection cases
billingRouter.post('/billing/collection-cases', requirePermission('billing:create'), idempotency(), billingController.openCollectionCase);
billingRouter.get('/billing/collection-cases', requirePermission('billing:read'), billingController.listCollectionCases);
billingRouter.get('/billing/collection-cases/:id', requirePermission('billing:read'), billingController.getCollectionCase);
billingRouter.post('/billing/collection-cases/:id/agreements', requirePermission('billing:update'), idempotency(), billingController.createCollectionAgreement);

// Rent adjustments
billingRouter.post('/billing/rent-adjustments', requirePermission('billing:create'), idempotency(), billingController.requestRentAdjustment);
billingRouter.get('/billing/rent-adjustments', requirePermission('billing:read'), billingController.listRentAdjustments);
billingRouter.get('/billing/rent-adjustments/:id', requirePermission('billing:read'), billingController.getRentAdjustment);

// Guaranteed rent
billingRouter.post('/billing/guaranteed-rent', requirePermission('billing:create'), idempotency(), billingController.enrollGuaranteedRent);
billingRouter.get('/billing/guaranteed-rent', requirePermission('billing:read'), billingController.listGuaranteedRentContracts);
billingRouter.get('/billing/guaranteed-rent/:id', requirePermission('billing:read'), billingController.getGuaranteedRentContract);
billingRouter.post('/billing/guaranteed-rent/:id/pay', requirePermission('billing:approve'), idempotency(), billingController.payGuaranteedRent);

// Rent advances
billingRouter.post('/billing/rent-advances', requirePermission('billing:create'), idempotency(), billingController.requestRentAdvance);
billingRouter.get('/billing/rent-advances', requirePermission('billing:read'), billingController.listRentAdvances);
billingRouter.get('/billing/rent-advances/:id', requirePermission('billing:read'), billingController.getRentAdvance);
billingRouter.post('/billing/rent-advances/:id/propose', requirePermission('billing:update'), idempotency(), billingController.proposeRentAdvance);
billingRouter.post('/billing/rent-advances/:id/accept', requirePermission('billing:approve'), idempotency(), billingController.acceptRentAdvance);
billingRouter.post('/billing/rent-advances/:id/pay', requirePermission('billing:approve'), idempotency(), billingController.payRentAdvance);
billingRouter.post('/billing/rent-advances/:id/recover', requirePermission('billing:update'), idempotency(), billingController.recoverRentAdvance);

// Collection cadence (régua de cobrança via Motor de Regras, REG-LOC-004)
billingRouter.get('/billing/collection-cadence', requirePermission('billing:read'), billingController.getCollectionCadence);
billingRouter.post('/billing/collection-cadence/versions', requirePermission('billing:cadence:manage'), idempotency(), billingController.publishCollectionCadence);
billingRouter.get('/billing/collection-cadence/steps', requirePermission('billing:read'), billingController.listCollectionCadenceSteps);

// Utilities
billingRouter.post('/billing/utility-obligations', requirePermission('billing:create'), idempotency(), billingController.createUtilityObligation);
billingRouter.get('/billing/utility-obligations', requirePermission('billing:read'), billingController.listUtilityObligations);
billingRouter.get('/billing/utility-obligations/:id', requirePermission('billing:read'), billingController.getUtilityObligation);
billingRouter.post('/billing/utility-accounts', requirePermission('billing:create'), idempotency(), billingController.createUtilityAccount);
billingRouter.post('/billing/utility-obligations/:id/payments', requirePermission('billing:update'), idempotency(), billingController.recordUtilityPayment);
// Fechamento M5 (§12): vencimentos (ciclos) da obrigação e dispensa registrada de um vencimento.
billingRouter.get('/billing/utility-obligations/:id/cycles', requirePermission('billing:read'), obligationCyclesController.listObligationCycles);
billingRouter.post('/billing/utility-cycles/:id/waive', requirePermission('billing:approve'), idempotency(), obligationCyclesController.waiveObligationCycle);
billingRouter.post('/billing/utility-obligations/:id/ownership-transfer', requirePermission('billing:update'), idempotency(), billingController.requestOwnershipTransfer);
billingRouter.post('/billing/ownership-transfer-tasks/:id/complete', requirePermission('billing:update'), idempotency(), billingController.completeOwnershipTransfer);

// Closeout
billingRouter.get('/billing/contracts/:contractId/closeout-eligibility', requirePermission('billing:read'), billingController.checkCloseoutEligibility);
billingRouter.post('/billing/contracts/:contractId/closeout', requirePermission('billing:update'), idempotency(), billingController.closeoutContract);

billingRouter.use(replayErrorHandler);

module.exports = billingRouter;
