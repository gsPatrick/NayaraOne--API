'use strict';

/** Origens aceitas e regras de cada uma (M9-D807 §3.2). São enumerações do livro, não códigos de erro. */
const SYSTEM_IMPORT = 'SYSTEM_IMPORT';
const SOURCES = Object.freeze(['DOCUMENT', 'PERSON_STATEMENT', 'OFFICIAL_REGISTRY', SYSTEM_IMPORT, 'OTHER']);
const FILE_REQUIRED_SOURCES = Object.freeze(['DOCUMENT', 'OFFICIAL_REGISTRY']);
const NOTE_REQUIRED_SOURCES = Object.freeze(['OTHER', 'PERSON_STATEMENT']);

/** Famílias da lista de campos críticos (prefixo de cada item do parâmetro). */
const FAMILIES = Object.freeze(['PERSON', 'PROPERTY', 'SUPPLIER', 'REPASSE']);

/** Tipos de entidade gravados em field_change_evidence.entity_type (a família de cada um vem da lista de campos críticos). */
const ENTITY_TYPES = Object.freeze({ PERSON: 'PERSON', PROPERTY: 'PROPERTY', BANK_ACCOUNT: 'BANK_ACCOUNT', PROPERTY_OWNER: 'PROPERTY_OWNER', REPASSE: 'REPASSE' });

module.exports = { SYSTEM_IMPORT, ENTITY_TYPES, SOURCES, FILE_REQUIRED_SOURCES, NOTE_REQUIRED_SOURCES, FAMILIES };
