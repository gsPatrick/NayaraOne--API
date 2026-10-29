'use strict';

/** Constantes da memória empresarial da NAY (M9-D009). Os quatro tipos são os do livro (seção 7); nenhum outro é aceito. */
const MEMORY_TYPES = Object.freeze(['DECISION', 'COMPANY_PREFERENCE', 'APPROVED_PROCEDURE', 'RECOMMENDATION_OUTCOME']);
const SCOPES = Object.freeze(['COMPANY', 'USER', 'AGENT', 'SESSION']);
const STATUSES = Object.freeze(['ACTIVE', 'INVALIDATED', 'EXPIRED', 'SUPERSEDED']);
const CLASSIFICATIONS = Object.freeze(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']);
const SOURCE_TYPES = Object.freeze(['RUN', 'RECOMMENDATION', 'KNOWLEDGE_ENTRY']);
const DEFAULT_CLASSIFICATION = 'INTERNAL';
/** Só uma pessoa com ai:admin grava estes tipos (a NAY apenas propõe). */
const ADMIN_TYPES = Object.freeze(['COMPANY_PREFERENCE', 'APPROVED_PROCEDURE']);
/** Os dois tipos que aceitam `transcript` quando o administrador liga a guarda da conversa inteira. */
const TRANSCRIPT_TYPES = Object.freeze(['DECISION', 'RECOMMENDATION_OUTCOME']);
const PROPOSAL_TYPE = 'MEMORY_PROPOSAL';

module.exports = {
  MEMORY_TYPES, SCOPES, STATUSES, CLASSIFICATIONS, SOURCE_TYPES, DEFAULT_CLASSIFICATION, ADMIN_TYPES, TRANSCRIPT_TYPES, PROPOSAL_TYPE,
};
