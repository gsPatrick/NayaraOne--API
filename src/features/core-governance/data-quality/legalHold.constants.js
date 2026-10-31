'use strict';

/** Vocabulário fechado da retenção legal (M9-D912). Os tipos são os mesmos do CHECK da migration 878 e os que a retenção (M9-D911) e os pontos de exclusão informam ao guarda. */
const ENTITY_TYPES = Object.freeze(['PERSON', 'PROPERTY', 'CONTRACT', 'LEGAL_CASE', 'FISCAL_OBLIGATION', 'TAX_DOCUMENT', 'FILE', 'ACCESS_SIGNAL', 'AUDIT_LOG', 'INTEGRATION']);
const COMPANY = 'COMPANY';
const WILDCARD = '*';
const STATUS = Object.freeze({ ACTIVE: 'ACTIVE', RELEASED: 'RELEASED' });
const ORIGIN = Object.freeze({ EXPLICIT: 'EXPLICIT', DERIVED: 'DERIVED' });
/** Itens de escopo: o registro isolado (ENTITY), a pessoa, o contrato, o processo, a empresa inteira e o tipo de dado (com período opcional). */
const SCOPE_TYPES = Object.freeze({ ENTITY: 'ENTITY', PERSON: 'PERSON', CONTRACT: 'CONTRACT', LEGAL_CASE: 'LEGAL_CASE', COMPANY: 'COMPANY', DATA_TYPE: 'DATA_TYPE' });

const MANAGE_PERMISSION = 'governance:legal-hold:manage';
const READ_PERMISSIONS = Object.freeze([MANAGE_PERMISSION, 'governance:data-quality:read']);
const ACTION_RELEASE = 'legal_hold.release';
const AUDIT = Object.freeze({ CREATED: 'governance.legal_hold.created', RELEASED: 'governance.legal_hold.released', BLOCKED: 'governance.legal_hold.blocked' });
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const CHUNK = 5000;

module.exports = { ENTITY_TYPES, COMPANY, WILDCARD, STATUS, ORIGIN, SCOPE_TYPES, MANAGE_PERMISSION, READ_PERMISSIONS, ACTION_RELEASE, AUDIT, CODE_PATTERN, CHUNK };
