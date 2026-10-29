'use strict';

/** Faixas dos parâmetros e da política de contingência (arquivo puro: o SETTINGS_SCHEMA e a leitura usam a mesma faixa). */
const PADROES = Object.freeze({
  queueMaxAgeH: 24, bankMaxPendingH: 72, recoveryChecks: 3, notifyRoles: 'ADMIN', manualTaskAssigneeRole: 'ADMIN', manualTaskDueH: 4, drainBatchSize: 50, manualTaskBatchSize: 100,
});
const LIMITES = Object.freeze({
  queueMaxAgeH: { min: 1, max: 720 },
  bankMaxPendingH: { min: 1, max: 720 },
  recoveryChecks: { min: 1, max: 20 },
  manualTaskDueH: { min: 1, max: 720 },
  drainBatchSize: { min: 1, max: 1000 },
  manualTaskBatchSize: { min: 1, max: 1000 },
});
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inRange = (v, lim) => Number.isInteger(v) && v >= lim.min && v <= lim.max;

module.exports = { PADROES, LIMITES, UUID_RE, inRange };
