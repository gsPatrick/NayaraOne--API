'use strict';

const { definePort } = require('../ports/definePort');

/** Port SiteAdapter (domínio SITE, M9-D209): operações, entradas e saída normalizada versionadas. */
const SiteAdapter = definePort('SiteAdapter', 'SITE', {
  publishPage: ['slug'],
  unpublishPage: ['slug'],
  getPageStatus: ['slug'],
});

module.exports = { SiteAdapter };
