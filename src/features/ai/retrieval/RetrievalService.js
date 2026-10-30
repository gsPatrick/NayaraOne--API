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
const { factsOfChunks, conflictsOf } = require('./retrieval.conflicts');
const { recordNotVigent } = require('./retrieval.notVigent');

// Padrão do parâmetro ia.rag.consulta_max_caracteres (retrieval.settings); o valor da empresa chega por `params.queryMax`.
const QUERY_MAX = 2000;

function parseQuery(query, max = QUERY_MAX) {
  const text = typeof query === 'string' ? query.replace(/\s+/g, ' ').trim() : '';
  if (!text || text.length > max) throw E.searchInvalid('Informe o que você quer consultar.');
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
 * M9-D024: revogada, expirada, substituída e de início posterior nunca entram; as que casaram com a pergunta são registradas no run com
 * `used_in_answer = false` e o estado delas. Fontes vigentes que declaram o mesmo fato com valores diferentes voltam em `conflicts`
 * (e todas entram no resultado, sem escolher uma).
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

  async search(ctx, query, optsIn = {}, transaction = optsIn.transaction) {
    V.ctxOk(ctx);
    const opts = { ...optsIn, now: optsIn.now || new Date() };
    if (opts.companyId && opts.companyId !== ctx.companyId) throw E.crossCompany();
    const params = await readRagParams(ctx, transaction);
    const text = parseQuery(query, params.queryMax);
    const args = await this.searchArgs(ctx, text, opts, params, transaction);
    const found = await searchCandidates(args, transaction);
    const allowed = await allowedSources(ctx, found, allowedClassifications(ctx, opts), transaction, opts.now);
    const ranked = rerank(found.filter((c) => allowed.has(sourceKey(c.sourceType, c.sourceId))));
    const limit = Math.min(Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : params.contextMaxChunks, params.contextMaxChunks);
    const rows = ranked.length ? await chunks.findByIds(ctx, ranked.map((c) => c.id), transaction) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const facts = await factsOfChunks(ctx, ranked.filter((c) => byId.has(c.id)), byId, params.factMarker, transaction);
    const conflicts = conflictsOf(ranked, facts);
    const inConflict = new Set(conflicts.flatMap((c) => c.versions.map((v) => sourceKey(v.sourceType, v.sourceRef))));
    const top = new Set(ranked.slice(0, limit).map((c) => c.id));
    const items = ranked.filter((c) => byId.has(c.id) && (top.has(c.id) || (facts.has(c.id) && inConflict.has(sourceKey(c.sourceType, c.sourceId)))))
      .map((c) => ({ ...this.toItem(c, byId.get(c.id)), facts: facts.get(c.id) || [] }));
    if (opts.runId) {
      await recordRetrieved({ ...ctx, runId: opts.runId }, items, transaction);
      await recordNotVigent(ctx, args, params.nonVigentMax, opts.runId, transaction);
    }
    if (!items.length) return { items: [], insufficient: true, message: INSUFFICIENT_MESSAGE };
    return conflicts.length ? { items, insufficient: false, conflicts } : { items, insufficient: false }; // `conflicts` só existe quando há divergência (a forma da resposta não revela nada mais)
  }

  /** Candidatos (só metadados e pontuação) já filtrados pelo banco; também usado pela evidência de plano de execução. */
  async candidates(ctx, text, opts, params, transaction) {
    return searchCandidates(await this.searchArgs(ctx, text, opts, params, transaction), transaction);
  }

  async searchArgs(ctx, text, opts, params, transaction) {
    // M9-D228: com a IA fora a busca é só por palavras-chave (vetor nulo não casa com nenhum chunk: pesa apenas o texto).
    const q = opts.lexicalOnly === true ? { embedding: [0], norm: 1, model: '' } : await queryVector(ctx, text, transaction);
    return {
      companyId: ctx.companyId, now: opts.now || new Date(), permissions: [...new Set(ctx.permissions || [])], classes: allowedClassifications(ctx, opts),
      sourceTypes: allowedSourceTypes(opts), userId: ctx.userId, topK: params.topK, model: q.model, vector: q.embedding, norm: q.norm, queryText: text,
    };
  }

  /** Plano de execução da consulta de candidatos (evidência: empresa, estado e permissão filtram antes da similaridade). */
  async explain(ctx, query, opts = {}, transaction = opts.transaction) {
    V.ctxOk(ctx);
    const params = await readRagParams(ctx, transaction);
    return explainCandidates(await this.searchArgs(ctx, parseQuery(query, params.queryMax), opts, params, transaction), transaction);
  }

  toItem(c, row) {
    return {
      chunkId: row.id, sourceId: row.sourceId, sourceType: row.sourceType, sourceVersion: row.sourceVersion, chunkIndex: row.chunkIndex,
      content: row.contentRedacted, contentHash: row.contentHash, classification: row.classification, effectiveFrom: row.effectiveFrom,
      effectiveUntil: row.effectiveUntil, relevanceScore: score(c.relevance), untrusted: true, origin: 'rag', statusAtRetrieval: 'VIGENTE',
    };
  }

  /** Itens da busca no formato dos blocos `untrusted` do prompt (M9-D021): id, origem, classificação e texto. */
  toUntrusted(items) {
    return items.map((i) => ({ id: i.chunkId, origin: i.origin, classification: i.classification, text: i.content }));
  }
}

module.exports = { RetrievalService };
