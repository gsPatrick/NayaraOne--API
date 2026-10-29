'use strict';

/** Caixa de entrada de webhooks (Marco 9, M9-D203). Fachada da API pública. */
const { receiveEvent } = require('./inbox.receive');
const { claimBatch, markProcessed, markFailed, rejectInvalid } = require('./inbox.worker');
const { purgeWebhookInbox } = require('./inbox.retention');
const { requeueDeadLetter } = require('./inbox.requeue');
const { assertTransition } = require('./inbox.stateMachine');
const { readInboxParams, PADROES } = require('./inbox.params');
const { duplicatesCount } = require('./inbox.metrics');
const { STATUSES, TRANSITIONS } = require('./inbox.constants');

module.exports = {
  receiveEvent, claimBatch, markProcessed, markFailed, rejectInvalid, requeueDeadLetter, purgeWebhookInbox, assertTransition, readInboxParams, PADROES, duplicatesCount, STATUSES, TRANSITIONS,
};
