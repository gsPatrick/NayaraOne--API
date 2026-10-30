'use strict';

/** Ponte para o modo da IA (M9-D243): resolveAiMode e withAiFallback moram no framework de integrações; a IA só os usa pela fachada pública. */
const { resolveAiMode, withAiFallback } = require('../../integrations');

const MODE_DEGRADED = 'DEGRADE_TO_DETERMINISTIC';

module.exports = { resolveAiMode, withAiFallback, MODE_DEGRADED };
