'use strict';

/**
 * Handlers próprios das rotas literais do Guia M4 §15 que não são só um nome novo para um
 * handler existente (ver finance-official.routes.js).
 */
const catchAsync = require('../../../../utils/catchAsync');
const { success } = require('../../../../utils/httpResponse');
const periodClosuresService = require('../../application/services/closing.service');
const reconciliationQueue = require('../../application/services/reconciliation-queue.service');

const listPendingReconciliation = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) =>
    reconciliationQueue.listPendingQueue(t, { includeSuggestions: req.query.include === 'suggestions', tenant: { groupId: req.auth.groupId, companyId: req.auth.companyId } })
  );
  return success(res, { data });
});

const confirmReconciliationMatch = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) =>
    reconciliationQueue.confirmMatch(
      { groupId: req.auth.groupId, companyId: req.auth.companyId, bankTransactionId: req.params.id, financialEntryId: req.body && req.body.financialEntryId },
      req.auth.userId,
      t
    )
  );
  return success(res, { statusCode: 201, data });
});

/** POST /finance/periods/:month/close — o mês vem do caminho; o resto é o mesmo de POST /finance/period-closures. */
const closePeriodByMonth = catchAsync(async (req, res) => {
  const payload = { ...req.body, referenceMonth: req.params.month, groupId: req.auth.groupId, companyId: req.auth.companyId };
  const item = await req.withTenantTransaction((t) => periodClosuresService.closePeriod(payload, req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});

module.exports = { listPendingReconciliation, confirmReconciliationMatch, closePeriodByMonth };
