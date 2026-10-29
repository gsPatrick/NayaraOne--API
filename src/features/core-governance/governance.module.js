'use strict';

const { Router } = require('express');
const catchAsync = require('../../utils/catchAsync');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const { getSetting } = require('../../features/settings/settings.service');
const { govModuleDisabled } = require('./governance.errors');
const { moduleSettingKey, GOVERNANCE_SETTING_DEFAULTS } = require('./governance.settings');

function tenantFromAuth(req) {
  return { groupId: req.auth.groupId, companyId: req.auth.companyId };
}

/** O módulo está ligado para a empresa? Padrão ligado; o administrador desliga em Configurações > Governança. */
async function isModuleEnabled(code, tenant, transaction) {
  const value = await getSetting(moduleSettingKey(code), tenant, transaction, GOVERNANCE_SETTING_DEFAULTS[moduleSettingKey(code)]);
  return value !== false;
}

/** Middleware: recusa com 403 GOV_MODULE_DISABLED quando o administrador desligou o módulo da empresa. Vem DEPOIS da checagem de permissão. */
function requireModuleEnabled(code) {
  return catchAsync(async (req, res, next) => {
    const enabled = await req.withTenantTransaction((transaction) => isModuleEnabled(code, tenantFromAuth(req), transaction));
    if (!enabled) throw govModuleDisabled(code);
    return next();
  });
}

/**
 * Monta o router de um módulo de governança. Autenticação e tenant valem SÓ sob o prefixo do módulo (router.use sem caminho
 * interceptaria qualquer requisição de /v1; ver comentário em src/routes/index.js). Cada rota: permissão -> módulo ligado -> handler (`before` roda antes da permissão, ex.: auditar a tentativa negada; `after` entre o módulo ligado e o handler, ex.: Idempotency-Key e MFA).
 */
function buildModuleRouter(mod, routeDefs) {
  const router = Router();
  router.use(mod.prefix, authMiddleware, tenantMiddleware);
  for (const def of routeDefs) {
    router[def.method](def.path, ...(def.before || []), requirePermission(def.permission), requireModuleEnabled(mod.code), ...(def.after || []), catchAsync(def.handler));
  }
  return router;
}

module.exports = { buildModuleRouter, requireModuleEnabled, isModuleEnabled, tenantFromAuth };
