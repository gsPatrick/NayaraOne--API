'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const legalCasesService = require('./legalCases.service');
const legalCaseDocumentsService = require('./legalCaseDocuments.service');
const legalCaseTimelineService = require('./legalCaseTimeline.service');
const legalCaseReceivablesService = require('./legalCaseReceivables.service');
const noticeVersionsService = require('./noticeVersions.service');

/**
 * Rotas do processo jurídico que faltavam na API (Caderno M5 §14): partes formais, documentos e
 * provas ligados por file_links e a linha do tempo. Separado de legal.controller.js (já grande)
 * para não crescer um arquivo só; o serviço de cada um está no arquivo de mesmo nome.
 */
const addLegalCaseParty = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => legalCasesService.addLegalCaseParty(req.params.id, req.body || {}, req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});

const listLegalCaseParties = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction(async (t) => {
    await legalCasesService.getLegalCase(req.params.id, t); // processo de outra empresa = 404, não lista vazia
    return legalCasesService.listLegalCaseParties(req.params.id, t);
  });
  return success(res, { data: items });
});

const linkLegalCaseDocument = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => legalCaseDocumentsService.linkCaseDocument(req.params.id, req.body || {}, req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});

const listLegalCaseDocuments = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => legalCaseDocumentsService.listCaseDocuments(req.params.id, t));
  return success(res, { data: items });
});

const getLegalCaseTimeline = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => legalCaseTimelineService.getLegalCaseTimeline(req.params.id, t));
  return success(res, { data });
});

// §14: valor confirmado -> recebível vinculado ao Financeiro (só quando juridicamente cabível).
const linkLegalCaseReceivable = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => legalCaseReceivablesService.linkCaseReceivable(req.params.id, req.body || {}, req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});

const listLegalCaseReceivables = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => legalCaseReceivablesService.listCaseReceivables(req.params.id, t));
  return success(res, { data: items });
});

// DoD "notificações versionadas": nova versão do conteúdo (a anterior fica preservada) e histórico.
const createNoticeVersion = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => noticeVersionsService.createNoticeVersion(req.params.id, req.body || {}, req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});

const listNoticeVersions = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => noticeVersionsService.listNoticeVersions(req.params.id, t));
  return success(res, { data: items });
});

module.exports = {
  addLegalCaseParty, listLegalCaseParties, linkLegalCaseDocument, listLegalCaseDocuments, getLegalCaseTimeline,
  linkLegalCaseReceivable, listLegalCaseReceivables, createNoticeVersion, listNoticeVersions,
};
