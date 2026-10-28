'use strict';

/** Envios a fornecedores (Marco 9, M9-D205). Fachada da API pública. */
const { createDispatch } = require('./dispatch.create');
const { transitionDispatch } = require('./dispatch.transition');
const { retryDispatchManually } = require('./dispatch.retry');
const { claimDue } = require('./dispatch.claim');
const { recoverStaleSending } = require('./dispatch.stale');
const { purgeDispatches } = require('./dispatch.retention');
const { TRANSITIONS, refusalReason } = require('./dispatchStateMachine');
const { canonicalize, hashPayload } = require('./canonicalJson');
const { readDispatchParams, PADROES } = require('./dispatch.params');
const { translateDispatchDbError } = require('./dispatch.errors');
const { STATUSES } = require('./dispatch.constants');

module.exports = {
  createDispatch, transitionDispatch, retryDispatchManually, claimDue, recoverStaleSending, purgeDispatches,
  TRANSITIONS, refusalReason, canonicalize, hashPayload, readDispatchParams, PADROES, translateDispatchDbError, STATUSES,
};
