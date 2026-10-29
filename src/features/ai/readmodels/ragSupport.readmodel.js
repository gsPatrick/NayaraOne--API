'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/**
 * Apoio SQL do RAG (M9-D022 e M9-D023). Único lugar de retrieval/ que fala SQL (archGuard AI-004: consulta direta só em readmodels/).
 *  - trava de ingestão por fonte (duas ingestões do mesmo conteúdo viram um índice só);
 *  - candidatos da busca: filtro de empresa, estado, vigência, permissão, classificação e dono FEITO PELO BANCO antes de qualquer
 *    similaridade ou texto, devolvendo só metadados e pontuação (nunca o conteúdo do chunk).
 */
async function acquireIngestionLock(companyId, sourceKind, sourceId, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', { replacements: { key: `ai.ingestion:${companyId}:${sourceKind}:${sourceId}` }, transaction });
}

const CANDIDATES_SQL = `
SELECT c.id, c.source_id, c.source_type, c.source_version, c.chunk_index, c.classification, c.effective_from, c.effective_until, c.required_permission,
       c.cosine, c.text_rank, GREATEST(c.cosine, c.text_rank) AS relevance
  FROM (
    SELECT k.id, k.source_id, k.source_type, k.source_version, k.chunk_index, k.classification, k.effective_from, k.effective_until, k.required_permission,
           CASE WHEN k.embedding_model = :model AND cardinality(k.embedding) = cardinality(CAST(:qvec AS float8[]))
                THEN GREATEST(0, (SELECT COALESCE(sum(a * b), 0) FROM unnest(k.embedding, CAST(:qvec AS float8[])) AS t(a, b)) / (k.embedding_norm * :qnorm))
                ELSE 0 END AS cosine,
           ts_rank_cd(to_tsvector('portuguese', k.content_redacted), plainto_tsquery('portuguese', :qtext), 32) AS text_rank
      FROM ai.chunks k
     WHERE k.company_id = :companyId
       AND k.status = 'ACTIVE'
       AND k.effective_from <= :now AND (k.effective_until IS NULL OR k.effective_until > :now)
       AND k.required_permission IN (:permissions)
       AND k.classification IN (:classes)
       AND k.source_type IN (:sourceTypes)
       AND (k.owner_scope <> 'USER' OR k.owner_user_id = :userId)
  ) c
 WHERE c.cosine > 0 OR c.text_rank > 0
 ORDER BY relevance DESC, c.id ASC
 LIMIT :topK`;

function candidateArgs(a) {
  return {
    companyId: a.companyId, now: a.now, permissions: a.permissions, classes: a.classes, sourceTypes: a.sourceTypes, userId: a.userId || null, topK: a.topK,
    model: a.model, qvec: `{${a.vector.join(',')}}`, qnorm: a.norm, qtext: a.queryText,
  };
}

/**
 * searchCandidates({ companyId, now, permissions, classes, userId, topK, model, vector, norm, queryText }, transaction) =>
 * [{ id, sourceId, sourceType, sourceVersion, chunkIndex, classification, effectiveFrom, effectiveUntil, requiredPermission, cosine, textRank, relevance }]
 * Lista vazia de permissões, de classes ou de tipos de fonte = nenhum candidato (nada é lido).
 */
async function searchCandidates(args, transaction) {
  if (!args.permissions.length || !args.classes.length || !args.sourceTypes.length) return [];
  const rows = await sequelize.query(CANDIDATES_SQL, { replacements: candidateArgs(args), type: QueryTypes.SELECT, transaction });
  return rows.map((r) => ({
    id: r.id, sourceId: r.source_id, sourceType: r.source_type, sourceVersion: r.source_version, chunkIndex: r.chunk_index,
    classification: r.classification, effectiveFrom: r.effective_from, effectiveUntil: r.effective_until, requiredPermission: r.required_permission,
    cosine: Number(r.cosine), textRank: Number(r.text_rank), relevance: Number(r.relevance),
  }));
}

/** Plano de execução da mesma consulta (evidência de que empresa, estado e permissão filtram antes da similaridade). */
async function explainCandidates(args, transaction) {
  const rows = await sequelize.query(`EXPLAIN (COSTS OFF) ${CANDIDATES_SQL}`, { replacements: candidateArgs(args), type: QueryTypes.SELECT, transaction });
  return rows.map((r) => r['QUERY PLAN']);
}

module.exports = { acquireIngestionLock, searchCandidates, explainCandidates };
