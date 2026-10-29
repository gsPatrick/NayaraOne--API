'use strict';

// M9-D613 — API pública da camada dashboards do BI. As demandas do Marco 9 acrescentam aqui o que a camada expõe.
const catalog = require('./dashboard.catalog');
const service = require('./dashboard.service');
const routes = require('./dashboard.routes');
const cache = require('./cache');

module.exports = { camada: 'dashboards', ...catalog, ...service, ...routes, ...cache };
