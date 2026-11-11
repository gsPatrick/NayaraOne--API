'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const AppError = require('../../utils/AppError');
const settingsService = require('../settings/settings.service');
const { KEY, BASES, DEFAULT_BASE, getCostBasis } = require('./costBasis');

// Parâmetro da empresa: base do custo financeiro realizado das obras (CAIXA | COMPETENCIA), na tela Obras → Configurações.
// A gravação passa pelo dicionário de parâmetros (validação do enum, permissão construction:approve e auditoria
// settings.create/settings.update com antes/depois em audit.audit_log).
const getCostBasisSetting = catchAsync(async (req, res) => {
  const tenant = { groupId: req.auth.groupId, companyId: req.auth.companyId };
  const data = await req.withTenantTransaction(async (t) => {
    const row = await settingsService.getSettingRow(KEY, tenant, t).catch(() => null);
    return { key: KEY, base: await getCostBasis(tenant, t), default: DEFAULT_BASE, options: BASES, configured: Boolean(row), updatedAt: row ? row.updatedAt : null };
  });
  return success(res, { data });
});

const updateCostBasisSetting = catchAsync(async (req, res) => {
  const base = req.body && typeof req.body.base === 'string' ? req.body.base.trim().toUpperCase() : req.body && req.body.base;
  if (!BASES.includes(base)) {
    throw AppError.badRequest(`"base" deve ser ${BASES.join(' ou ')}.`, 'CONSTRUCTION_COST_BASIS_INVALID', { options: BASES });
  }
  const tenant = { groupId: req.auth.groupId, companyId: req.auth.companyId };
  const data = await req.withTenantTransaction(async (t) => {
    const row = await settingsService.upsertSetting(KEY, base, tenant, req.auth.userId, t, { permissions: req.auth.permissions });
    return { key: KEY, base: row.value, default: DEFAULT_BASE, options: BASES, configured: true, updatedAt: row.updatedAt };
  });
  return success(res, { data });
});

module.exports = { getCostBasisSetting, updateCostBasisSetting };
