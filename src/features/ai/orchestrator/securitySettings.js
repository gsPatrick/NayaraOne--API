'use strict';

const { getSetting } = require('../../../features/settings/settings.service');
const { SECURITY_SETTING_DEFAULTS } = require('./security.settings');

const EXCERPT_KEY = 'ia.seguranca.trecho_auditoria_max_caracteres';
const EXTRA_TERMS_KEY = 'ia.seguranca.termos_segredo_extra';

/** Lê os parâmetros da empresa do contexto: tamanho do trecho de auditoria e termos extras de segredo (lista separada por vírgula). */
async function loadSecuritySettings(tenant, transaction) {
  const scope = { groupId: tenant.groupId, companyId: tenant.companyId };
  const excerpt = await getSetting(EXCERPT_KEY, scope, transaction, SECURITY_SETTING_DEFAULTS[EXCERPT_KEY]);
  const extra = await getSetting(EXTRA_TERMS_KEY, scope, transaction, SECURITY_SETTING_DEFAULTS[EXTRA_TERMS_KEY]);
  return {
    excerptMax: Number.isInteger(excerpt) && excerpt >= 20 ? excerpt : SECURITY_SETTING_DEFAULTS[EXCERPT_KEY],
    extraTerms: String(extra || '').split(',').map((t) => t.trim()).filter(Boolean),
  };
}

module.exports = { loadSecuritySettings, EXCERPT_KEY, EXTRA_TERMS_KEY };
