'use strict';

/**
 * Handlers HTTP da autorização em duas pessoas do Financeiro: caso de estorno (Guia M4 §8 e §15) e reabertura de período pelo fluxo
 * CRITICAL (Caderno §16, Guia §18). O pedido responde 202 (aceito, aguardando a outra pessoa); a aprovação devolve o que foi feito.
 * Um caso/pedido que ficou desatualizado é marcado STALE e a transação COMMITA antes do 409 (a invalidação fica gravada).
 */
const catchAsync = require('../../../../utils/catchAsync');
const { success } = require('../../../../utils/httpResponse');
const AppError = require('../../../../utils/AppError');
const reversalCases = require('../../application/services/reversal-case.service');
const periodReopen = require('../../application/services/period-reopen.service');
const { withTenant } = require('./finance-request');

const staleError = (what) => AppError.conflict(`${what} mudou depois do pedido: o pedido foi invalidado. Faça um novo pedido sobre a versão atual.`, 'FINANCE_APPROVAL_STALE');

// --- Estorno: pedido (finance:reverse + MFA), aprovação/recusa por outra pessoa (finance:approve + MFA) ---
const requestEntryReversal = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => reversalCases.requestReversal(req.params.id, req.body || {}, req.auth.userId, t));
  return success(res, { statusCode: 202, data: item });
});
const requestLedgerReversal = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => reversalCases.requestReversal(req.params.id, req.body || {}, req.auth.userId, t, { viaLedger: true }));
  return success(res, { statusCode: 202, data: item });
});
const listReversalCases = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => reversalCases.listReversalCases(t, { status: req.query.status, entryId: req.query.entryId }));
  return success(res, { data: items });
});
const approveReversalCase = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => reversalCases.approveReversalCase(req.params.id, req.auth.userId, t));
  if (result.stale) throw staleError('O lançamento');
  return success(res, { data: result });
});
const rejectReversalCase = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => reversalCases.rejectReversalCase(req.params.id, req.body || {}, req.auth.userId, t));
  return success(res, { data: result });
});

// --- Reabertura de período: pedido e decisão, as duas pontas com finance:periodReopen + MFA ---
const requestPeriodReopen = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => periodReopen.requestPeriodReopen(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 202, data: item });
});
const listPeriodReopenRequests = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => periodReopen.listPeriodReopenRequests(t, { status: req.query.status }));
  return success(res, { data: items });
});
const approvePeriodReopen = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => periodReopen.approvePeriodReopen(req.params.id, req.auth.userId, t));
  if (result.stale) throw staleError('O fechamento');
  return success(res, { data: result });
});
const rejectPeriodReopen = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => periodReopen.rejectPeriodReopen(req.params.id, req.auth.userId, t));
  return success(res, { data: result });
});

module.exports = {
  requestEntryReversal,
  requestLedgerReversal,
  listReversalCases,
  approveReversalCase,
  rejectReversalCase,
  requestPeriodReopen,
  listPeriodReopenRequests,
  approvePeriodReopen,
  rejectPeriodReopen,
};
