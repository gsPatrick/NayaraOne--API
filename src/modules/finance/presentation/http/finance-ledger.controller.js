'use strict';

/**
 * Handlers do ledger que não cabem em finance.controller.js: o COMPLEMENTO (Caderno M4 §6 — quitação do saldo de um
 * lançamento que já tem movimento) com chave de idempotência obrigatória (FIN-004), como a baixa parcial.
 */
const catchAsync = require('../../../../utils/catchAsync');
const { success } = require('../../../../utils/httpResponse');
const receiptService = require('../../application/services/receipt.service');
const { readClientKey, validateClientKey } = require('../../application/services/settlement-idempotency');
const { manualSettlementFromBody } = require('./finance-request');

const settleFinancialEntryComplement = catchAsync(async (req, res) => {
  const idempotencyKey = validateClientKey(readClientKey(req), { required: true });
  const body = req.body || {};
  const item = await req.withTenantTransaction((t) =>
    receiptService.settleFinancialEntryComplement(req.params.id, req.auth.userId, t, {
      manualSettlement: manualSettlementFromBody(body),
      idempotencyKey,
      expectedAmount: body.expectedAmount,
    })
  );
  return success(res, { data: item });
});

module.exports = { settleFinancialEntryComplement };
