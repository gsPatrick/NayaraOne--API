'use strict';

const { definePort } = require('../ports/definePort');
const { site } = require('../../minimization/mappers');

/**
 * Port SiteAdapter (domínio SITE, M9-D209 e M9-D259): `publishPage({pageKey, slug, locale, contentRef, contentHash})`, `unpublishPage({pageKey})` e `getPageStatus({pageKey})`, com o
 * formato normalizado de saída (`externalRequestId`, `externalResourceId`, `status`); mappers de saída da M9-D219 (allowlist de campos públicos, conteúdo só do read model público da M9-D231).
 */
const SiteAdapter = definePort('SiteAdapter', 'SITE', {
  publishPage: { required: ['pageKey', 'slug'], outputMapper: site.publishPage },
  unpublishPage: { required: ['pageKey'], outputMapper: site.unpublishPage },
  getPageStatus: ['pageKey'],
});

module.exports = { SiteAdapter };
