'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const AppError = require('../../utils/AppError');
const settingsService = require('../settings/settings.service');
const projectTypesService = require('./projectTypes.service');
const checklistTemplatesService = require('./checklistTemplates.service');
const approvalThresholdsService = require('./approvalThresholds.service');
const { listBudgetRevisions } = require('./budgetRevisions.service');
const { listActiveMembers } = require('./companyRefs');
const { KEYS, DEFAULTS, CONSTRUCTION_SETTINGS_SCHEMA, getConstructionSettings } = require('./construction.settings');

/**
 * Rotas de configuração e consulta de Obras criadas na verificação independente do Marco 6: tipos de obra e checklist
 * por tipo/etapa (M6-12/M6-86), alçadas (M6-29/M6-107), parâmetros de Obras (M6-21 evidência mínima; M6-108 diário
 * ausente) e revisões do orçamento aprovado (M6-17/M6-82). O tenant vem sempre do token, nunca do corpo.
 */
const tenantOf = (req) => ({ groupId: req.auth.groupId, companyId: req.auth.companyId });
const withTenant = (req) => ({ ...req.body, ...tenantOf(req) });

const listProjectTypes = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => projectTypesService.listProjectTypes(t, { includeInactive: req.query.active !== 'true' }));
  return success(res, { data });
});
const createProjectType = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => projectTypesService.createProjectType(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data });
});
const updateProjectType = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => projectTypesService.updateProjectType(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data });
});

const listChecklistTemplates = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => checklistTemplatesService.listChecklistTemplates(t, { projectTypeId: req.query.projectTypeId }));
  return success(res, { data });
});
const createChecklistTemplate = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => checklistTemplatesService.createChecklistTemplate(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data });
});
const updateChecklistTemplate = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => checklistTemplatesService.updateChecklistTemplate(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data });
});
const applyProjectChecklist = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => checklistTemplatesService.applyProjectChecklist(req.params.id, req.auth.userId, t));
  return success(res, { data: { created: data.length, items: data } });
});

const listApprovalThresholds = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => approvalThresholdsService.listApprovalThresholds(req.auth.companyId, t));
  return success(res, { data });
});
const upsertApprovalThreshold = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => approvalThresholdsService.upsertApprovalThreshold(withTenant(req), req.auth.userId, t));
  return success(res, { data });
});

const listBudgetRevisionsOfProject = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => listBudgetRevisions(req.params.id, t));
  return success(res, { data });
});

// Membros ativos da empresa para os campos de responsável (obra, etapa, NC): o mesmo critério que a gravação confere.
const listMembers = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => listActiveMembers(req.auth.companyId, t));
  return success(res, { data });
});

const getParameters = catchAsync(async (req, res) => {
  const values = await req.withTenantTransaction((t) => getConstructionSettings(tenantOf(req), t));
  return success(res, { data: { values, defaults: DEFAULTS, keys: KEYS } });
});
/** Grava um ou mais parâmetros de Obras: cada chave passa pelo serviço de parâmetros (validação, permissão e auditoria). */
const updateParameters = catchAsync(async (req, res) => {
  const values = (req.body && req.body.values) || {};
  const keys = Object.keys(values);
  if (!keys.length || keys.some((k) => !CONSTRUCTION_SETTINGS_SCHEMA[k])) {
    throw AppError.badRequest(`Informe em "values" só parâmetros de Obras: ${Object.keys(CONSTRUCTION_SETTINGS_SCHEMA).join(', ')}.`, 'CONSTRUCTION_PARAMETER_INVALID');
  }
  const data = await req.withTenantTransaction(async (t) => {
    for (const key of keys) {
      await settingsService.upsertSetting(key, values[key], tenantOf(req), req.auth.userId, t, { permissions: req.auth.permissions });
    }
    return getConstructionSettings(tenantOf(req), t);
  });
  return success(res, { data: { values: data, defaults: DEFAULTS, keys: KEYS } });
});

module.exports = {
  listProjectTypes,
  createProjectType,
  updateProjectType,
  listChecklistTemplates,
  createChecklistTemplate,
  updateChecklistTemplate,
  applyProjectChecklist,
  listApprovalThresholds,
  upsertApprovalThreshold,
  listBudgetRevisionsOfProject,
  getParameters,
  updateParameters,
  listMembers,
};
