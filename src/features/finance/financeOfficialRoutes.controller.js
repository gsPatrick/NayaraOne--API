'use strict';

/**
 * Handlers próprios das rotas literais do Guia M4 §15 que não são só um nome novo para um
 * handler existente (ver financeOfficialRoutes.routes.js).
 */
const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const AppError = require('../../utils/AppError');
const { sequelize } = require('../../models');
const financialEntriesService = require('./financialEntries.service');
const periodClosuresService = require('./periodClosures.service');
const reconciliationQueue = require('./reconciliationQueue.service');

/**
 * POST /finance/ledger/:id/reverse — o :id é o id da linha da view finance.ledger (Caderno §5/§7).
 * Na view, cada movimento realizado tem o id do próprio lançamento liquidado (ou da baixa parcial
 * filha). Só movimento que está no ledger pode ser estornado por aqui; o estorno é o mesmo de
 * POST /finance/entries/:id/reverse (novo lançamento compensatório, original intacto).
 */
const reverseLedgerMovement = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction(async (t) => {
    const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id);
    const [rows] = valid ? await sequelize.query('SELECT id FROM finance.ledger WHERE id = :id', { replacements: { id: req.params.id }, transaction: t }) : [[]];
    if (rows.length === 0) {
      throw AppError.notFound('Movimento não encontrado no ledger (só movimento realizado pode ser estornado).', 'FINANCE_LEDGER_MOVEMENT_NOT_FOUND');
    }
    return financialEntriesService.reverseFinancialEntry(req.params.id, req.body.reason, req.auth.userId, t);
  });
  return success(res, { data: result });
});

const listPendingReconciliation = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) =>
    reconciliationQueue.listPendingQueue(t, { includeSuggestions: req.query.include === 'suggestions' })
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

module.exports = { reverseLedgerMovement, listPendingReconciliation, confirmReconciliationMatch, closePeriodByMonth };
