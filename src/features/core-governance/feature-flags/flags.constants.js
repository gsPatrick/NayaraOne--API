'use strict';

/**
 * Constantes do registro de feature flags e configurações (M9-D870). Listas FECHADAS do livro/da demanda; o que varia por empresa é parâmetro (flags.settings.js).
 * As tabelas são uma lista branca: o nome da tabela nunca vem da requisição.
 */
const KINDS = Object.freeze({ FLAG: 'FLAG', CONFIG: 'CONFIG' });
const TABLES = Object.freeze({ FLAG: 'governance.feature_flags', CONFIG: 'governance.config_entries' });
const VALUE_TYPES = Object.freeze(['BOOLEAN', 'INTEGER', 'DECIMAL', 'STRING', 'ENUM', 'JSON']);
/** Do mais amplo ao mais específico: a posição na lista é a precedência (USER vence SECTOR, que vence COMPANY, e assim por diante). */
const SCOPES = Object.freeze(['GLOBAL', 'ENVIRONMENT', 'GROUP', 'COMPANY', 'SECTOR', 'USER']);
const RISKS = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const STATES = Object.freeze({ ACTIVE: 'ACTIVE', EXPIRED: 'EXPIRED' });
const SOURCES = Object.freeze({ REGISTRY: 'REGISTRY', TENANT_SETTING: 'TENANT_SETTING' });

/** `dominio.recurso.nome`: minúsculas, dígitos, `_` e `-` em cada trecho, pelo menos dois trechos. */
const KEY_RE = /^[a-z][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/;
const KEY_MAX = 128;

const AUDIT_ACTION = 'governance.flag.changed';
const AUDIT_ENTITY = Object.freeze({ FLAG: 'governance.feature_flag', CONFIG: 'governance.config_entry' });

module.exports = { KINDS, TABLES, VALUE_TYPES, SCOPES, RISKS, STATES, SOURCES, KEY_RE, KEY_MAX, AUDIT_ACTION, AUDIT_ENTITY };
