'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const contractTemplatesService = require('./contractTemplates.service');

/** Versões do modelo (Caderno M5 §6/§19): publicar a versão em rascunho (governança) e listar o histórico. */
const publishContractTemplate = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => contractTemplatesService.publishTemplate(req.params.id, req.auth.userId, t));
  return success(res, { data });
});
const listContractTemplateVersions = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => contractTemplatesService.listTemplateVersions(req.params.id, t));
  return success(res, { data });
});

module.exports = { publishContractTemplate, listContractTemplateVersions };
