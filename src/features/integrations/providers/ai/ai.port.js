'use strict';

const { definePort } = require('../ports/definePort');
const { ai } = require('../../minimization/mappers');

/** Port AiAdapter (domínio AI, M9-D209): operações, entradas e saída normalizada versionadas. */
const AiAdapter = definePort('AiAdapter', 'AI', {
  generate: { required: ['prompt'], outputMapper: ai.generate },
  embed: ['input'],
  transcribe: ['mediaRef'],
  analyzeImage: ['mediaRef'],
});

module.exports = { AiAdapter };
