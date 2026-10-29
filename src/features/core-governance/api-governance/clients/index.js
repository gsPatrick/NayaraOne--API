'use strict';

const service = require('./clients.service');
const { issueToken } = require('./token.service');
const { clientAuth, requireScope } = require('./clientAuth.middleware');
const { routesWithoutScope, assertAllRoutesDeclareScope, describeRoutes } = require('./external.sweep');
const { peekClientClaims } = require('./token');
const { CLIENTS_SETTING_DEFAULTS, CLIENTS_SETTINGS_SCHEMA } = require('./clients.settings');

module.exports = { ...service, issueToken, clientAuth, requireScope, routesWithoutScope, assertAllRoutesDeclareScope, describeRoutes, peekClientClaims, CLIENTS_SETTING_DEFAULTS, CLIENTS_SETTINGS_SCHEMA };
