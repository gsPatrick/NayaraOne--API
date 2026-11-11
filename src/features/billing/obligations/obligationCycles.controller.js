'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const utilitiesService = require('../utilities.service');
const cycles = require('./obligationCycles.service');

// Ciclos (vencimentos) de uma obrigação da locação e dispensa de um vencimento (fechamento M5, livro §12).
const listObligationCycles = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction(async (t) => {
    const obligation = await utilitiesService.getUtilityObligation(req.params.id, t);
    return cycles.listCycles(obligation.id, t);
  });
  return success(res, { data: items });
});

const waiveObligationCycle = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => cycles.waiveCycle(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data: item });
});

module.exports = { listObligationCycles, waiveObligationCycle };
