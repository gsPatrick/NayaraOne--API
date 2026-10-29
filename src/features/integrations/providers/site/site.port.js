'use strict';

const { definePort } = require('../ports/definePort');
const { site } = require('../../minimization/mappers');

/** Port SiteAdapter (domínio SITE, M9-D209): operações, entradas e saída normalizada versionadas; mappers de saída da M9-D219. */
const SiteAdapter = definePort('SiteAdapter', 'SITE', {
  publishPage: { required: ['slug'], outputMapper: site.publishPage },
  unpublishPage: { required: ['slug'], outputMapper: site.unpublishPage },
  getPageStatus: ['slug'],
});

module.exports = { SiteAdapter };
