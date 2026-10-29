'use strict';

/** Ações do operador sobre as integrações (Marco 9, M9-D250). */
const { retryError } = require('./retry.service');
const { testConnection } = require('./testConnection.service');
const { rotateSecret } = require('./rotate.service');
const { ACTIONS_SETTINGS_SCHEMA } = require('./actions.settings');
const { readActionParams, PADROES } = require('./actions.params');

module.exports = { retryError, testConnection, rotateSecret, ACTIONS_SETTINGS_SCHEMA, readActionParams, ACTION_PADROES: PADROES };
