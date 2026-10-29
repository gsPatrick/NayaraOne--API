'use strict';

/** Analytics e monitoramento (Marco 9, M9-D243): emissão assíncrona sem dado pessoal e descarte do que não saiu a tempo. */
const { emitMetric, emitEvent, emitError } = require('./analytics.emit');
const { dropExpiredAnalytics } = require('./analytics.drop');
const { assertNoPersonalData } = require('./analytics.pii');
const { errorToEvent } = require('./analytics.errorEvent');
const { readAnalyticsParams } = require('./analytics.params');
const { registerDispatchCycleStep } = require('../dispatch/worker/worker.hooks');

let installed = false;

/** Liga o descarte ao início de cada rodada do worker de envios (chamado no boot, junto com os adapters). */
function installAnalytics() {
  if (installed) return;
  installed = true;
  registerDispatchCycleStep((ctx, args, transaction) => dropExpiredAnalytics(ctx, args, transaction));
}

module.exports = { emitMetric, emitEvent, emitError, dropExpiredAnalytics, assertNoPersonalData, errorToEvent, readAnalyticsParams, installAnalytics };
