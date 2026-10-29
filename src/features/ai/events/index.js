'use strict';

const { publishAiEvent } = require('./aiEvents.publish');
const { CATALOG, EVENT_VERSION, CLASSIFICATION } = require('./aiEvents.catalog');
const helpers = require('./aiEvents');

/** Eventos ai.* no outbox transacional (M9-D029). */
module.exports = { publishAiEvent, CATALOG, EVENT_VERSION, CLASSIFICATION, ...helpers };
