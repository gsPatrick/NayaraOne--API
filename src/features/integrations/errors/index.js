'use strict';

/** Erros de integração (Marco 9, M9-D207). Fachada que reexporta a API pública e liga o repórter de credencial vencida. */
const { recordError } = require('./errors.record');
const { listErrors } = require('./errors.list');
const { resolveError } = require('./errors.resolve');
const { registerResolveHandler } = require('./errors.hooks');
const { recordUnknownWebhook } = require('./errors.unknownWebhook');
const { migrateLegacyIntegrationErrors } = require('./errors.legacy');
const { readErrorParams, PADROES } = require('./errors.params');
const { severityFor } = require('./errors.severity');
const { serializeError } = require('./errors.serialize');
const { sanitizeForError } = require('./sanitizeForError');
const { reportarIncidenteDeCredencial } = require('./errors.secretReporter');
const { registerSecretIncidentReporter } = require('../secrets/secretIncidents');

registerSecretIncidentReporter(reportarIncidenteDeCredencial);

module.exports = {
  recordError, listErrors, resolveError, registerResolveHandler, recordUnknownWebhook, migrateLegacyIntegrationErrors,
  readErrorParams, PADROES, severityFor, serializeError, sanitizeForError,
};
