'use strict';

const repo = require('./ingestion.repository');
const chunks = require('./chunks.repository');
const { auditIngestion } = require('./ingestion.audit');

/**
 * Elo entre o conhecimento homologado (M9-D008) e o RAG (M9-D022, passo 1): a ingestão de KNOWLEDGE_ENTRY é AUTOMÁTICA. Ao homologar a
 * entrada, a MESMA transação cria a linha PENDING em ai.ingestions (nenhum ato humano adicional) e o job a leva até INDEXED; a revogação
 * ou a substituição retira os chunks da busca na mesma transação (a vigência fina é da M9-D024). Nada aqui lê o conteúdo.
 */
async function enqueueKnowledge(ctx, entry, transaction) {
  await repo.lockSource(ctx, 'KNOWLEDGE_ENTRY', entry.id, transaction);
  const existing = await repo.findOpenVersion(ctx, 'KNOWLEDGE_ENTRY', entry.id, entry.version, transaction);
  if (existing) return existing;
  const row = await repo.create(ctx, {
    sourceKind: 'KNOWLEDGE_ENTRY', sourceRef: entry.id, sourceId: entry.id, sourceVersion: entry.version, status: 'PENDING', step: 'AUTHORIZE',
    classification: entry.classification,
  }, transaction);
  await auditIngestion(ctx, 'ai.ingestion.pending', row, null, 'Ingestão automática criada pela homologação do conhecimento.', transaction);
  return row;
}

/** Tira da busca os chunks do conhecimento que foi revogado (`REVOKED`) ou substituído por nova versão (`SUPERSEDED`). */
async function retractKnowledge(ctx, entryId, status, transaction) {
  return chunks.retractSource(ctx, 'KNOWLEDGE_ENTRY', entryId, status, transaction);
}

module.exports = { enqueueKnowledge, retractKnowledge };
