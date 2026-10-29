'use strict';

/** Reconciliação de envios incertos (Marco 9, M9-D215). Fachada da API pública. */
const { reconcileDispatch, reconcileDue, isDue } = require('./reconcile.service');
const { resolveDispatchByEvent } = require('./reconcile.event');
const { recoverStaleSending } = require('./orphan');
const { readReconcileParams, waitBeforeAttemptS, PADROES } = require('./reconcile.params');
const { classifyExternalStatus } = require('./reconcile.outcome');
const { registerReconcileEnricher } = require('./reconcile.enrichers');
const { REASON_UNRESOLVED } = require('./reconcile.deadLetter');

module.exports = {
  reconcileDispatch, reconcileDue, isReconcileDue: isDue, resolveDispatchByEvent, recoverStaleSending, readReconcileParams, waitBeforeAttemptS,
  RECONCILE_PADROES: PADROES, classifyExternalStatus, registerReconcileEnricher, REASON_UNRESOLVED,
};
