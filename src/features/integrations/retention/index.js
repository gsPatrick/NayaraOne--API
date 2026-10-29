'use strict';

/** Retenção das tabelas de integração (Marco 9, M9-D244). Fachada da API pública. */
const { purgeExpired, AUDIT_ACTION, ENTITY_TYPE } = require('./retention.service');
const { readRetentionPayload, readJobHour, AREAS, PADROES } = require('./retention.params');

module.exports = { purgeExpired, readRetentionPayload, readJobHour, AREAS, PADROES, AUDIT_ACTION, ENTITY_TYPE };
