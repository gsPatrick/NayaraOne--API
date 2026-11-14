'use strict';

const catchAsync = require('../../../../utils/catchAsync');
const { success } = require('../../../../utils/httpResponse');
const nayDraft = require('./nayDraft.service');

/** Minuta sugerida pela NAY (Caderno M5 §17): sugerir, listar, aceitar (pessoa) e descartar (com motivo). */
const tenantOf = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId });

const suggestDraft = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => nayDraft.suggestDraft(tenantOf(req), req.params.id, req.auth.userId, t));
  return success(res, { statusCode: 201, data });
});
const listDraftSuggestions = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => nayDraft.listDraftSuggestions(req.params.id, t));
  return success(res, { data });
});
const acceptDraftSuggestion = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => nayDraft.acceptDraftSuggestion(req.params.id, req.body || {}, req.auth.userId, t));
  return success(res, { statusCode: 201, data });
});
const discardDraftSuggestion = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => nayDraft.discardDraftSuggestion(req.params.id, req.body || {}, req.auth.userId, t));
  return success(res, { data });
});

module.exports = { suggestDraft, listDraftSuggestions, acceptDraftSuggestion, discardDraftSuggestion };
