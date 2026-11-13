'use strict';

const catchAsync = require('../../../../utils/catchAsync');
const { success } = require('../../../../utils/httpResponse');
const { homologateClauseVersion } = require('./clauseHomologation.service');

/** POST /legal/clauses/:id/homologate — Caderno M5 §4 "Versões homologadas" (legal:approve; quem escreveu não homologa). */
const homologateClause = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => homologateClauseVersion(req.params.id, req.auth.userId, t));
  return success(res, { data });
});

module.exports = { homologateClause };
