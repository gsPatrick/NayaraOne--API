'use strict';

const { SCALE } = require('../../../shared/data-classification/scale');

/** Vocabulário fechado do registro de classificação (M9-D910 §3.1). Os mesmos valores estão nos CHECKs da migration 856. */
const PURPOSES = Object.freeze(['CONTRATO', 'COBRANCA', 'OBRIGACAO_LEGAL', 'ATENDIMENTO', 'MARKETING', 'SEGURANCA', 'OPERACAO_INTERNA', 'ANALISE']);
const MASKINGS = Object.freeze(['NONE', 'PARTIAL', 'FULL', 'HASH', 'TOKENIZE']);
const EXPORTABILITY = Object.freeze(['ALLOWED', 'ALLOWED_MASKED', 'WITH_APPROVAL', 'FORBIDDEN']);
const SOURCE = Object.freeze({ AUTO: 'AUTO', MANUAL: 'MANUAL' });

/** Colunas técnicas que não precisam de linha no registro (M9-D910 §3.2.1). */
const TECHNICAL_COLUMNS = Object.freeze(['id', 'created_at', 'updated_at', 'group_id', 'company_id']);
/** Schemas que não são de negócio (catálogo do Postgres e a tabela de controle das migrations). */
const SYSTEM_SCHEMAS = Object.freeze(['pg_catalog', 'information_schema', 'pg_toast', 'public']);

const READ_PERMISSION = 'governance:data-quality:read';
const MANAGE_PERMISSION = 'governance:classification:manage';
const TECHNICAL_DOMAIN = 'CLASSIFICACAO_TECNICA';
const DOCUMENT = 'docs/governance/data-classification.json';
const DEFAULT_MASKING = 'PARTIAL';

module.exports = { CLASSES: SCALE, PURPOSES, MASKINGS, EXPORTABILITY, SOURCE, TECHNICAL_COLUMNS, SYSTEM_SCHEMAS, READ_PERMISSION, MANAGE_PERMISSION, TECHNICAL_DOMAIN, DOCUMENT, DEFAULT_MASKING };
