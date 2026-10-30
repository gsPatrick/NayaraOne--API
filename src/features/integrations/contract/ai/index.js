'use strict';

const transport = require('./ai.scenarios.transport');
const data = require('./ai.scenarios.data');
const { buildAiContext } = require('./ai.context');

/** Os 10 cenários da M9-D222 para os adapters de modelo (fixture com `shape: "ai-model"`): mesmos números e nomes da suíte comum. */
const AI_SCENARIOS = Object.freeze([
  [1, 'auth', transport.auth], [2, 'happy path', transport.happyPath], [3, 'timeout', transport.timeout], [4, '4xx', transport.client4xx], [5, '5xx', transport.server5xx],
  [6, 'rate limit', transport.rateLimit], [7, 'duplicate request', data.duplicate], [8, 'malformed response', data.malformed], [9, 'status mapping', data.statusMapping], [10, 'health check', data.health],
]);

const isAiShape = (fixture) => Boolean(fixture) && fixture.shape === 'ai-model';

module.exports = { AI_SCENARIOS, buildAiContext, isAiShape };
