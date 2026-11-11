'use strict';

/**
 * Rotas literais do Guia do Marcelo — Centro Financeiro §15 "APIs mínimas" (o livro manda o
 * caminho). Cada uma usa a MESMA permissão, o mesmo MFA e o mesmo guarda das rotas equivalentes
 * que já existiam (que continuam valendo, porque a tela as usa):
 *   POST /finance/payments/prepare           = POST /finance/payment-intents
 *   POST /finance/payments/:id/approve       = POST /finance/payment-intents/:id/approve
 *   POST /finance/payments/:id/execute       = POST /finance/payment-intents/:id/execute (MFA recente)
 *   POST /finance/ledger/:id/reverse         = POST /finance/entries/:id/reverse (id da linha de finance.ledger; confirmação nível 3)
 *   GET  /finance/reconciliation/pending     = fila: extrato sem conciliação + pendências de classificação
 *   POST /finance/reconciliation/:id/confirm = confirmação humana do match da transação :id (§11)
 *   GET  /finance/health                     = GET /finance/reports/weekly-health
 *   POST /finance/periods/:month/close       = POST /finance/period-closures (mês no caminho)
 */
const { Router } = require('express');
const { authMiddleware, requirePermission, requireRecentMfa } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const { confirmAction } = require('../../shared/destructive-actions/guard');
const financeController = require('./finance.controller');
const official = require('./financeOfficialRoutes.controller');

const router = Router();
const guard = [authMiddleware, tenantMiddleware];

router.post('/finance/payments/prepare', ...guard, requirePermission('finance:create'), financeController.createPaymentIntent);
router.post('/finance/payments/:id/approve', ...guard, requirePermission('finance:approve'), financeController.approvePaymentIntent);
router.post('/finance/payments/:id/execute', ...guard, requirePermission('finance:settle'), requireRecentMfa, financeController.executePaymentIntent);
router.post('/finance/ledger/:id/reverse', ...guard, requirePermission('finance:settle'), confirmAction('finance.entry.reverse', { reasonField: 'reason' }), official.reverseLedgerMovement);
router.get('/finance/reconciliation/pending', ...guard, requirePermission('finance:read'), official.listPendingReconciliation);
router.post('/finance/reconciliation/:id/confirm', ...guard, requirePermission('finance:reconcile'), official.confirmReconciliationMatch);
router.get('/finance/health', ...guard, requirePermission('finance:read'), financeController.getWeeklyHealthReport);
router.post('/finance/periods/:month/close', ...guard, requirePermission('finance:settle'), official.closePeriodByMonth);

module.exports = router;
