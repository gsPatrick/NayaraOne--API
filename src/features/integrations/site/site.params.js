'use strict';

const { getSetting } = require('../../settings/settings.service');

const PADROES = Object.freeze({ defaultLocale: 'pt-BR' });

/** Parâmetros do site da empresa, com o padrão do parametros.csv quando não configurados. */
async function readSiteParams(tenant, transaction) {
  const locale = await getSetting('integration.site.default_locale', tenant, transaction, PADROES.defaultLocale);
  return { defaultLocale: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(String(locale)) ? String(locale) : PADROES.defaultLocale };
}

module.exports = { readSiteParams, PADROES };
