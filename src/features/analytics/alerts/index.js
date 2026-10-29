'use strict';

// M9-D613 / M9-D691 — API pública da camada alerts do BI: o alert engine (avaliação, fingerprint, estados, eventos e alertas semente).
// `camada` identifica a camada (contrato do teste de estrutura); as demandas do Marco 9 acrescentam aqui o que a camada expõe.
const service = require('./engine.service');
const events = require('./events');
const transitions = require('./transitions');
const { fingerprintOf } = require('./fingerprint');
const { compareThreshold } = require('./decimal');
const settings = require('./engine.settings');
const ownerChange = require('./owner.change');
const { buildNotification } = require('./notify.service');

module.exports = {
  camada: 'alerts',
  evaluateCompanyAlerts: service.evaluateCompanyAlerts,
  transitionAlert: service.transitionAlert,
  syncSeedAlerts: service.syncSeedAlerts,
  REFRESH_LOG_MODEL: service.REFRESH_LOG_MODEL,
  onAlertEvent: events.onAlertEvent,
  emitAlertEvent: events.emitAlertEvent,
  ALERT_EVENT_TYPES: events.TYPES,
  assertTransition: transitions.assertTransition,
  fingerprintOf,
  compareThreshold,
  readAlertParams: settings.readAlertParams,
  changeAlertOwner: ownerChange.changeAlertOwner,
  buildNotification,
};
