'use strict';

const { router, publicRouter } = require('./seo.routes');
const service = require('./seo.service');

module.exports = { router, publicRouter, service, ...require('./seo.settings'), ...require('./seo.slug'), ...require('./seo.lifecycle'), ...require('./seo.metadata'), ...require('./seo.verify'), ...require('./seo.sitemap') };
