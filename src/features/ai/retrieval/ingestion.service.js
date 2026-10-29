'use strict';

const E = require('./retrieval.errors');
const V = require('./ingestion.input');
const repo = require('./ingestion.repository');
const { describeSource } = require('./ingestion.sources');
const { runPipeline } = require('./ingestion.pipeline');
const { settle } = require('./ingestion.settle');
const { toIngestion } = require('./ingestion.mapper');
const { readRagParams } = require('./retrieval.params');

/**
 * Serviço de ingestão do RAG (M9-D022). `ingest` roda o pipeline de ponta a ponta numa transação do tenant, com trava por fonte: duas
 * ingestões do mesmo conteúdo resultam em um índice só (a segunda vê a primeira e devolve `replayed`). A recusa de conteúdo
 * (malware, sem classificação, URL, segredos...) NÃO lança: grava a linha REJECTED/FAILED e a devolve, para o registro sobreviver à
 * resposta de erro; o controller converte em HTTP com `rejectionError`. Falta de permissão (403) e origem inexistente (404) lançam, sem linha.
 * `opts.system` (job e homologação) dispensa a checagem de quem pede; `opts.fetchOptions` são ganchos de teste da busca de URL.
 */
async function run(ctx, input, transaction, { system = false, pending = null, fetchOptions } = {}) {
  await repo.lockSource(ctx, input.sourceKind, input.sourceId, transaction);
  const desc = await describeSource(ctx, input, transaction, { system });
  const params = await readRagParams(ctx, transaction);
  if (desc.kind === 'KNOWLEDGE_ENTRY' && !pending) {
    const existing = await repo.findOpenVersion(ctx, desc.kind, desc.sourceId, desc.version, transaction);
    if (existing && existing.status !== 'PENDING') return { ingestion: toIngestion(existing), replayed: true };
    if (existing) pending = existing;
  }
  if (pending && pending.status !== 'PENDING') return { ingestion: toIngestion(pending), replayed: true };
  const result = await runPipeline(ctx, input, desc, params, transaction, { fetchOptions });
  if (result.replay) return { ingestion: toIngestion(result.replay), replayed: true };
  const row = await settle(ctx, desc, input, pending, result, transaction);
  return { ingestion: toIngestion(row), replayed: false };
}

async function ingest(ctx, body, transaction, opts = {}) {
  const input = V.parseIngestInput(ctx, body);
  return run(ctx, input, transaction, opts);
}

async function get(ctx, id, transaction) {
  V.ctxOk(ctx);
  if (!V.isUuid(id)) throw E.notFound();
  const row = await repo.findById(ctx, id, transaction);
  if (!row) throw E.notFound();
  const isAdmin = Array.isArray(ctx.permissions) && (ctx.permissions.includes('ai:admin') || ctx.permissions.includes('ai:audit'));
  if (!isAdmin && row.createdBy !== ctx.userId) throw E.notFound();
  return toIngestion(row);
}

/**
 * Processa as ingestões PENDING da empresa (conhecimento homologado), mais antigas primeiro. Cada uma roda como o sistema (a pessoa que
 * homologou já foi autorizada na homologação). Devolve quantas chegaram a um estado final.
 */
async function processPending(ctx, transaction, { limit = 20, fetchOptions } = {}) {
  V.ctxOk(ctx);
  const rows = await repo.listPending(ctx, limit, transaction);
  const outcomes = [];
  for (const row of rows) {
    const input = { sourceKind: row.sourceKind, sourceRef: row.sourceRef, sourceId: row.sourceId, classification: null, reindex: false };
    try {
      const out = await run({ ...ctx, userId: row.createdBy || undefined }, input, transaction, { system: true, pending: row, fetchOptions });
      outcomes.push(out.ingestion);
    } catch (err) {
      // Conhecimento revogado ou substituído antes do job rodar: a ingestão deixa de valer (REJECTED), sem derrubar as demais.
      if (!err || !['AI_INGEST_NOT_AUTHORIZED', 'AI_INGEST_SOURCE_NOT_FOUND'].includes(err.code)) throw err;
      await row.update({ status: 'REJECTED', step: 'AUTHORIZE', errorCode: err.code, finishedAt: new Date() }, { transaction });
      outcomes.push(toIngestion(row));
    }
  }
  return outcomes;
}

module.exports = { ingest, get, processPending };
