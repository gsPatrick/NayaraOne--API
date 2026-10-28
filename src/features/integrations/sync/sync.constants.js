'use strict';

/** Constantes da sincronização retomável (Marco 9, M9-D208). */

const CURSOR_KINDS = Object.freeze(['TOKEN', 'TIMESTAMP', 'SEQUENCE']);
const CURSOR_STATUSES = Object.freeze(['IDLE', 'RUNNING', 'FAILED', 'STALLED']);
const ORIGINS = Object.freeze({ SCHEDULER: 'SCHEDULER', HUMAN_RETRY: 'HUMAN_RETRY' });
const STREAM_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const ENTITY_TYPE = 'IntegrationSyncCursor';
const AUDIT_ACTION = 'integration.sync.cursor.changed';
const STALLED_EVENT = 'integration.sync.stalled';

module.exports = { CURSOR_KINDS, CURSOR_STATUSES, ORIGINS, STREAM_RE, ENTITY_TYPE, AUDIT_ACTION, STALLED_EVENT };
