'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const { compareInspectionsWithNay } = require('../../../features/ai/agents/nay_juridica');

// POST /legal/nay/inspections/compare — a NAY compara a vistoria de entrada com a de saída e sugere as diferenças (livro §11).
const compareInspectionsNay = catchAsync(async (req, res) => {
  const body = req.body || {};
  const auth = { userId: req.auth.userId, groupId: req.auth.groupId, companyId: req.auth.companyId, permissions: req.auth.permissions || [], roles: req.auth.roles || [] };
  const data = await req.withTenantTransaction((t) => compareInspectionsWithNay(auth, { entryInspectionId: body.entryInspectionId, exitInspectionId: body.exitInspectionId }, t));
  return success(res, { data });
});

module.exports = { compareInspectionsNay };
