'use strict';

/** M9-D700 — leitura dos parâmetros de segurança do BI (getSetting com o padrão do livro/parâmetros). */
const { getSetting } = require('../../../features/settings/settings.service');
const { KEYS, SECURITY_SETTING_DEFAULTS } = require('./security.settings');

async function readParam(key, ctx, transaction) {
  return getSetting(key, { companyId: ctx.companyId, groupId: ctx.groupId }, transaction, SECURITY_SETTING_DEFAULTS[key]);
}

module.exports = { readParam, KEYS };
