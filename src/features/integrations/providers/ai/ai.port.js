'use strict';

const { definePort } = require('../ports/definePort');

/** Port AiAdapter (domínio AI, M9-D209): operações, entradas e saída normalizada versionadas. */
const AiAdapter = definePort('AiAdapter', 'AI', {
  generate: ['prompt'],
  embed: ['input'],
  transcribe: ['mediaRef'],
  analyzeImage: ['mediaRef'],
});

module.exports = { AiAdapter };
