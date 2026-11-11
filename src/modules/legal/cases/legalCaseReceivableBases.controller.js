'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const { RECEIVABLE_BASES } = require('../shared/legalRules.settings');
const { enabledReceivableBases } = require('../shared/legalRules.params');

// GET /legal/receivable-bases — as bases jurídicas aceitas hoje pela empresa (legal.processo.recebivel.base.<BASE>), com o rótulo.
const listReceivableBases = catchAsync(async (req, res) => {
  const accepted = await req.withTenantTransaction((t) => enabledReceivableBases({ groupId: req.auth.groupId, companyId: req.auth.companyId }, t));
  return success(res, { data: accepted.map((code) => ({ code, label: RECEIVABLE_BASES[code] })) });
});

module.exports = { listReceivableBases };
