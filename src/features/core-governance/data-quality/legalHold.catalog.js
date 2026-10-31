'use strict';

const { TIME_ZONE } = require('./retention.constants');

/**
 * Catálogo dos tipos de registro que podem estar sob retenção legal: a tabela, a coluna de data usada pelo escopo "tipo de dado com período" (null = sem tabela própria) e o
 * texto de existência. Os nomes dos tipos de arquivo ligado (file_links.related_entity_type) são os que o sistema grava hoje para pessoa, contrato e processo.
 */
const TABLES = Object.freeze({
  PERSON: { schema: 'people', table: 'persons', date: 'created_at' },
  PROPERTY: { schema: 'real_estate', table: 'properties', date: 'created_at' },
  CONTRACT: { schema: 'legal', table: 'contracts', date: 'created_at' },
  LEGAL_CASE: { schema: 'legal', table: 'legal_cases', date: 'created_at' },
  FISCAL_OBLIGATION: { schema: 'correspondent', table: 'fiscal_obligations', date: 'due_at' },
  TAX_DOCUMENT: { schema: 'finance', table: 'tax_documents', date: 'issued_at' },
  FILE: { schema: 'people', table: 'files', date: 'created_at' },
  ACCESS_SIGNAL: { schema: 'governance', table: 'access_signals', date: 'occurred_at' },
  AUDIT_LOG: { schema: 'audit', table: 'audit_log', date: 'occurred_at' },
  INTEGRATION: null,
});

const LINK_TYPES = Object.freeze({
  PERSON: ['people.persons', 'Person', 'PERSON'],
  CONTRACT: ['legal.contracts', 'Contract', 'CONTRACT'],
  LEGAL_CASE: ['legal.legal_cases', 'LegalCase', 'LEGAL_CASE'],
});

const qualified = (type) => `${TABLES[type].schema}.${TABLES[type].table}`;
const localDate = (type) => `(x.${TABLES[type].date} AT TIME ZONE '${TIME_ZONE}')::date`;

module.exports = { TABLES, LINK_TYPES, qualified, localDate };
