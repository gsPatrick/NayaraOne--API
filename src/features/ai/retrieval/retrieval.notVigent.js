'use strict';

const chunks = require('./chunks.repository');
const { searchNonVigent } = require('../readmodels/ragSupport.readmodel');
const { recordRetrieved } = require('./retrieval.sources');
const { allowedSources, sourceKey } = require('./doubleCheck');
const { statusAt } = require('./vigencia');
const { score } = require('./rerank');

/**
 * Fontes que casaram com a pergunta mas NÃO valem (M9-D024): revogada, expirada, substituída ou de início posterior. Nunca entram na
 * resposta; ficam no run com `used_in_answer = false` e o estado delas (REVOGADA, EXPIRADA, SUBSTITUIDA ou NAO_INICIADA), até
 * `ia.rag.nao_vigentes_registrar_max` por consulta (0 desliga). Os filtros de empresa, permissão e classificação são os da busca; arquivo
 * ainda passa pela conferência da origem. Devolve [{ chunkId, sourceId, sourceVersion, statusAtRetrieval }].
 */
async function recordNotVigent(ctx, args, max, runId, transaction) {
  const found = await searchNonVigent(args, max, transaction);
  if (!found.length) return [];
  const files = found.filter((c) => c.sourceType === 'FILE');
  const okFiles = files.length ? await allowedSources(ctx, files, args.classes, transaction, args.now) : new Set();
  const visible = found.filter((c) => c.sourceType !== 'FILE' || okFiles.has(sourceKey(c.sourceType, c.sourceId)));
  const rows = visible.length ? await chunks.findAnyByIds(ctx, visible.map((c) => c.id), transaction) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items = visible.filter((c) => byId.has(c.id)).map((c) => {
    const row = byId.get(c.id);
    return {
      chunkId: row.id, sourceId: row.sourceId, sourceType: row.sourceType, sourceVersion: row.sourceVersion, content: row.contentRedacted, contentHash: row.contentHash,
      classification: row.classification, effectiveFrom: row.effectiveFrom, effectiveUntil: row.effectiveUntil, relevanceScore: score(c.relevance),
      statusAtRetrieval: statusAt(row, args.now), usedInAnswer: false,
    };
  });
  await recordRetrieved({ ...ctx, runId }, items, transaction);
  return items.map((i) => ({ chunkId: i.chunkId, sourceId: i.sourceId, sourceVersion: i.sourceVersion, statusAtRetrieval: i.statusAtRetrieval }));
}

module.exports = { recordNotVigent };
