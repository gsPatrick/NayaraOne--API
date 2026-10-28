'use strict';

/** Constantes dos envios a fornecedores (M9-D205). O banco repete as listas em CHECK. */
const STATUSES = Object.freeze(['PENDING', 'SENDING', 'SUBMITTED', 'CONFIRMED', 'RETRY_WAIT', 'UNKNOWN', 'FAILED', 'DEAD_LETTER', 'CANCELLED']);
const CRITICALITY_OPS = Object.freeze(['DANGEROUS', 'SAFE']);
const ERROR_CLASSES = Object.freeze(['TRANSIENT', 'RATE_LIMIT', 'AUTH', 'VALIDATION', 'UNKNOWN']);
const AUDIT_ACTION = 'integration.dispatch.status_changed';
const ENTITY_TYPE = 'IntegrationDispatch';
const RETRY_PERMISSION = 'integration:retry';
/** Quanto o retry humano soma em max_attempts (D205 3.2). */
const HUMAN_RETRY_EXTRA_ATTEMPTS = 3;

module.exports = { STATUSES, CRITICALITY_OPS, ERROR_CLASSES, AUDIT_ACTION, ENTITY_TYPE, RETRY_PERMISSION, HUMAN_RETRY_EXTRA_ATTEMPTS };
