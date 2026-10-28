'use strict';

const { mktError, mktForbidden } = require('../../marketing.errors');
const { CADENCE_KEYS, CADENCE_DEFAULTS, PARSERS, isCadenceFamilyKey } = require('./cadence.settings');

const CADENCE_PERMISSION = 'marketing:automation:manage';

/** Texto normalizado para comparar: lista "[3, 30]" e "3,30" são o mesmo valor. */
function canonical(key, text) {
  const parsed = PARSERS[key](text);
  return parsed ? JSON.stringify(parsed) : null;
}

/**
 * Middleware do PUT /settings/:key para os parâmetros de cadência. Chave desconhecida da família: 404 MKT_PARAM_NOT_FOUND. Sem
 * marketing:automation:manage (além de settings:update): 403 MKT_FORBIDDEN. Mesmo valor que o vigente: responde 200 com a linha
 * atual e NÃO grava nem audita (não gera nova versão).
 */
async function requireAutomationManageForCadence(req, res, next) {
  try {
    const { key } = req.params;
    if (!isCadenceFamilyKey(key)) return next();
    if (!CADENCE_KEYS.includes(key)) throw mktError(404, 'MKT_PARAM_NOT_FOUND', 'Parâmetro não encontrado.', { code: key });
    if (!(req.auth.permissions || []).includes(CADENCE_PERMISSION)) throw mktForbidden({ required: CADENCE_PERMISSION, key });
    const value = req.body && req.body.value;
    const incoming = typeof value === 'string' ? canonical(key, value) : null;
    if (incoming === null) return next(); // inválido: o dicionário recusa com 422 MKT_PARAM_INVALID
    const { getSettingRow } = require('../../../../features/settings/settings.service');
    const tenant = { groupId: req.auth.groupId, companyId: req.auth.companyId };
    const row = await req.withTenantTransaction(async (t) => {
      try { return await getSettingRow(key, tenant, t); } catch (err) { return null; }
    });
    const current = row ? row.value : CADENCE_DEFAULTS[key];
    if (row && canonical(key, current) === incoming) {
      const { success } = require('../../../../utils/httpResponse');
      return success(res, { data: row });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { CADENCE_PERMISSION, requireAutomationManageForCadence };
