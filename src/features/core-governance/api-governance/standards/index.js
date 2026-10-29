'use strict';

const { rateLimitMiddleware, disabledInProcess: rateLimitDisabledInProcess } = require('./rateLimit.middleware');
const rateLimitCounter = require('./rateLimit.counter');
const { idempotency, replayErrorHandler } = require('./idempotency.middleware');
const { isRequired, IDEMPOTENCY_REQUIRED_ROUTES } = require('./idempotency.routes');
const { paginationGuard, parsePagination, buildPagination, pageResult, pageOfArray, checkPagination, MAX_PAGE_SIZE } = require('./pagination.helper');
const { STANDARDS_SETTING_DEFAULTS, STANDARDS_SETTINGS_SCHEMA } = require('./standards.settings');

module.exports = {
  rateLimitMiddleware, rateLimitDisabledInProcess, rateLimitCounter, idempotency, replayErrorHandler, isRequired, IDEMPOTENCY_REQUIRED_ROUTES, paginationGuard, parsePagination, buildPagination, pageResult, pageOfArray, checkPagination, MAX_PAGE_SIZE,
  STANDARDS_SETTING_DEFAULTS, STANDARDS_SETTINGS_SCHEMA,
};
