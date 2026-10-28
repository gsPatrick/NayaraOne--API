'use strict';

/** Listas fechadas de integration.integration_errors (M9-D207). O banco repete as mesmas listas em CHECK. */
const SOURCES = Object.freeze(['WEBHOOK', 'DISPATCH', 'SYNC', 'HEALTH', 'SECRET', 'CONTRACT']);
const ERROR_CLASSES = Object.freeze(['TRANSIENT', 'RATE_LIMIT', 'AUTH', 'VALIDATION', 'UNKNOWN', 'SECURITY']);
const SEVERITIES = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const STATUSES = Object.freeze(['OPEN', 'RETRYING', 'RESOLVED', 'IGNORED']);
const CLOSED_STATUSES = Object.freeze(['RESOLVED', 'IGNORED']);

const NOTE_MIN = 3;
const NOTE_MAX = 500;
const MESSAGE_MAX = 500;
const UNKNOWN_PROVIDER_LABEL = '(desconhecido)';

module.exports = {
  SOURCES, ERROR_CLASSES, SEVERITIES, STATUSES, CLOSED_STATUSES, NOTE_MIN, NOTE_MAX, MESSAGE_MAX, UNKNOWN_PROVIDER_LABEL,
};
