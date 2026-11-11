'use strict';

const { PEOPLE_ROLES_SETTINGS_SCHEMA } = require('./personRoles.settings');
const { PEOPLE_DEDUP_SETTINGS_SCHEMA } = require('./personDedup.settings');
const { PEOPLE_DOCUMENT_SETTINGS_SCHEMA } = require('./personDocument.settings');

/** Parâmetros de Pessoas do fechamento do Marco 3 (DI-M3PE-2, 3, 4 e 6), registrados no SETTINGS_SCHEMA de uma vez. */
const PEOPLE_M3PE_SETTINGS_SCHEMA = Object.freeze({ ...PEOPLE_ROLES_SETTINGS_SCHEMA, ...PEOPLE_DEDUP_SETTINGS_SCHEMA, ...PEOPLE_DOCUMENT_SETTINGS_SCHEMA });

module.exports = { PEOPLE_M3PE_SETTINGS_SCHEMA };
