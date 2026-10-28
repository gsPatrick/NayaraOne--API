'use strict';

const { analyticsMethodGuard } = require('./readOnly.methodGuard');
const { analyticsReadOnlyTransaction } = require('./readOnly.middleware');
const { ANALYTICS_WRITE_ROUTES } = require('./readOnly.writeRoutes');
const { listAnalyticsRoutes } = require('./readOnly.routeInventory');
const { resetReaderRoleProbe } = require('./readOnly.readerRole');
const settings = require('./readOnly.settings');

module.exports = {
  analyticsMethodGuard,
  analyticsReadOnlyTransaction,
  ANALYTICS_WRITE_ROUTES,
  listAnalyticsRoutes,
  resetReaderRoleProbe,
  ...settings,
};
