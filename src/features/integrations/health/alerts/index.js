'use strict';

/** Alertas operacionais das integrações (Marco 9, M9-D224). Ao carregar, registra o consumidor do evento integration.sync.stalled. */
const { ALERT_TYPES, ALERT_LABELS } = require('./alerts.constants');
const { readAlertParams, parseRoles } = require('./alerts.params');
const { evaluateConnectionConditions } = require('./alerts.conditions');
const { reconcileConnection } = require('./alerts.reconcile');
const { runAlertCycle } = require('./alerts.cycle');
const { onSyncStalled } = require('./alerts.syncStalled');
const { listOpenAlertsByConnection, listAlerts } = require('./alerts.query');
const { ALERT_SETTINGS_SCHEMA } = require('./alerts.settings');

module.exports = {
  ALERT_TYPES, ALERT_LABELS, ALERT_SETTINGS_SCHEMA, readAlertParams, parseRoles, evaluateConnectionConditions, reconcileConnection, runAlertCycle,
  onSyncStalled, listOpenAlertsByConnection, listAlerts,
};
