'use strict';

const consumersService = require('./consumers.service');
const deprecationsService = require('./deprecations.service');
const { evaluateDeprecations } = require('./evaluate.service');
const { deprecationMiddleware } = require('./deprecation.middleware');
const { flushUsage, resetUsageThrottle } = require('./usage');
const { clearContextCache } = require('./context');
const { CONSUMERS_SETTING_DEFAULTS, CONSUMERS_SETTINGS_SCHEMA } = require('./consumers.settings');

module.exports = {
  ...consumersService, ...deprecationsService, evaluateDeprecations, deprecationMiddleware, flushUsage, resetUsageThrottle, clearContextCache, CONSUMERS_SETTING_DEFAULTS, CONSUMERS_SETTINGS_SCHEMA,
};
