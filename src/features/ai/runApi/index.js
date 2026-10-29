'use strict';

const { registerRunApiRoutes } = require('./runApi.routes');
const { executeRequest } = require('./runApi.service');
const { chatPurpose } = require('./conversation');
const { RUN_API_SETTING_DEFAULTS, RUN_API_SETTINGS_SCHEMA } = require('./runApi.settings');

/** Porta de entrada da NAY (M9-D030): POST /ai/runs, POST /ai/agents/:code/chat e a conversa que agrupa os runs do chat. */
module.exports = { registerRunApiRoutes, executeRequest, chatPurpose, RUN_API_SETTING_DEFAULTS, RUN_API_SETTINGS_SCHEMA };
