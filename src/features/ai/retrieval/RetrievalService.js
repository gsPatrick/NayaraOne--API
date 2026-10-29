'use strict';

const E = require('./retrieval.errors');
const V = require('./ingestion.input');
const chunks = require('./chunks.repository');
const { readRagParams } = require('./retrieval.params');
const { searchCandidates, explainCandidates } = require('../readmodels/ragSupport.readmodel');
const { embedQuery } = require('./embedder');
const { allowedClassifications, allowedSourceTypes } = require('./retrieval.access');
const { allowedSources, sourceKey } = require('./doubleCheck');
const { rerank, score } = require('./rerank');
const { recordRetrieved } = require('./retrieval.sources');
const { INSUFFICIENT_MESSAGE } = require('./retrieval.constants');

const QUERY_MAX = 2000;

function parseQuery(query) {
  const text = typeof query === 'string' ? query.replace(/\s+/g, ' ').trim() : '';
  if (!text || text.length > QUERY_MAX) throw E.searchInvalid('Informe o que você quer consultar.');
  return text;
}

/** Vetor da consulta no modelo dos chunks; se o provedor de vetores falhar a busca segue só pelo texto (vetor vazio não casa com nenhum chunk). */
async function queryVector(ctx, text, transaction) {
  try {
    return await embedQuery({ groupId: ctx.groupId, companyId: ctx.companyId }, text, 'INTERNAL', transaction);
  } catch (err) {
    return { embedding: [0], norm: 1, model: '' };
  }
}

/**
 * RetrievalService — busca na base indexada da NAY (M9-D023), ordem fixa:
 * 1. empresa e estado ACTIVE, 2. permissão e classificação (os dois filtros no banco, ANTES de qualquer similaridade ou conteúdo; o que
 * falha aqui nem é candidato, não pesa na pontuação e não aparece em contagem), 3. similaridade + texto e rerank determinístico,
 * 4. somente vigentes (a vigência já filtra no banco e a origem é conferida de novo, dupla checagem), 5. registro em ai_sources.
 * O RAG não concede permissão: o resultado é só texto marcado `untrusted`; nada aqui soma permissão ao ator, e a tool que um trecho
 * "sugerir" passa de novo pela allowlist, pelo schema e pela permissão do ator (M9-D017/D021).
 * `search(ctx, query, opts, transaction)`: ctx = { groupId, companyId, userId, permissions, runId? }. opts: companyId (se informado e
 * diferente do ctx => 404 AI_CROSS_COMPANY_BLOCKED), purpose (finalidade, exigida para RESTRICTED), execution ({ allowsConfidential,
 * allowsRestricted, sourceTypes }), limit, runId (registra as fontes usadas), now (teste).
 */
class RetrievalService {
  constructor() {
    this.nome = 'RetrievalService';
  }

  async search(ctx, query, opts = {}, transaction = opts.transaction) {
    V.ctxOk(ctx);
    if (opts.companyId && opts.companyId !== ctx.companyId) throw E.crossCompany();
    const text = parseQuery(query);
    const params = await readRagParams(ctx, transaction);
    const found = await this.candidates(ctx, text, opts, params, transaction);
    const allowed = await allowedSources(ctx, found, allowedClassifications(ctx, opts), transaction);
    const ranked = rerank(found.filter((c) => allowed.has(sourceKey(c.sourceType, c.sourceId))));
    const limit = Math.min(Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : params.contextMaxChunks, params.contextMaxChunks);
    const top = ranked.slice(0, limit);
    const rows = top.length ? await chunks.findByIds(ctx, top.map((c) => c.id), transaction) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = top.filter((c) => byId.has(c.id)).map((c) => this.toItem(c, byId.get(c.id)));
    if (opts.runId && items.length) await recordRetrieved({ ...ctx, runId: opts.runId }, items, transaction);
    return items.length ? { items, insufficient: false } : { items: [], insufficient: true, message: INSUFFICIENT_MESSAGE };
  }

  /** Candidatos (só metadados e pontuação) já filtrados pelo banco; também usado pela evidência de plano de execução. */
  async candidates(ctx, text, opts, params, transaction) {
    return searchCandidates(await this.searchArgs(ctx, text, opts, params, transaction), transaction);
  }

  async searchArgs(ctx, text, opts, params, transaction) {
    const q = await queryVector(ctx, text, transaction);
    return {
      companyId: ctx.companyId, now: opts.now || new Date(), permissions: [...new Set(ctx.permissions || [])], classes: allowedClassifications(ctx, opts),
      sourceTypes: allowedSourceTypes(opts), userId: ctx.userId, topK: params.topK, model: q.model, vector: q.embedding, norm: q.norm, queryText: text,
    };
  }

  /** Plano de execução da consulta de candidatos (evidência: empresa, estado e permissão filtram antes da similaridade). */
  async explain(ctx, query, opts = {}, transaction = opts.transaction) {
    V.ctxOk(ctx);
    const params = await readRagParams(ctx, transaction);
    return explainCandidates(await this.searchArgs(ctx, parseQuery(query), opts, params, transaction), transaction);
  }

  toItem(c, row) {
    return {
      chunkId: row.id, sourceId: row.sourceId, sourceType: row.sourceType, sourceVersion: row.sourceVersion, chunkIndex: row.chunkIndex,
      content: row.contentRedacted, contentHash: row.contentHash, classification: row.classification, effectiveFrom: row.effectiveFrom,
      effectiveUntil: row.effectiveUntil, relevanceScore: score(c.relevance), untrusted: true, origin: 'rag',
    };
  }

  /** Itens da busca no formato dos blocos `untrusted` do prompt (M9-D021): id, origem, classificação e texto. */
  toUntrusted(items) {
    return items.map((i) => ({ id: i.chunkId, origin: i.origin, classification: i.classification, text: i.content }));
  }
}

module.exports = { RetrievalService };
