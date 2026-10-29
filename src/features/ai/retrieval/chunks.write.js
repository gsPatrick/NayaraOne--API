'use strict';

const crypto = require('node:crypto');
const repo = require('./chunks.repository');
const { CLASSIFICATIONS } = require('./retrieval.constants');

/**
 * Gravação dos chunks de uma versão (M9-D023). Todo chunk leva os metadados do livro copiados da fonte: source_id, source_version,
 * company_id, classification e vigência (effective_from; effective_until pode ficar aberta = sem fim). Chunk sem um deles NÃO é gravado
 * (a gravação inteira é recusada antes de tocar no banco). A versão anterior da fonte vira SUPERSEDED na MESMA transação, de modo que
 * a busca nunca vê duas versões ACTIVE.
 */
const fail = (field) => Object.assign(new Error(`CHUNK_METADATA_MISSING:${field}`), { code: 'CHUNK_METADATA_MISSING', field });
const hasValue = (v) => v !== null && v !== undefined && !(typeof v === 'string' && !v.trim());
const validDate = (v) => v instanceof Date ? !Number.isNaN(v.getTime()) : hasValue(v) && !Number.isNaN(new Date(v).getTime());

/** Confere os seis metadados obrigatórios de um chunk; lança CHUNK_METADATA_MISSING com o campo. */
function assertChunkMetadata(row) {
  if (!hasValue(row.sourceId)) throw fail('source_id');
  if (!Number.isInteger(row.sourceVersion) || row.sourceVersion < 1) throw fail('source_version');
  if (!hasValue(row.companyId)) throw fail('company_id');
  if (!CLASSIFICATIONS.includes(row.classification)) throw fail('classification');
  if (!validDate(row.effectiveFrom)) throw fail('effective_from');
  if (hasValue(row.effectiveUntil) && !validDate(row.effectiveUntil)) throw fail('effective_until');
  if (!hasValue(row.requiredPermission)) throw fail('required_permission');
  return row;
}

/** Linhas de ai.chunks para os pedaços e vetores de uma versão; os metadados vêm da fonte (`meta`) e da ingestão. */
function buildRows(ctx, ingestion, meta, chunks, vectors, model) {
  return chunks.map((c, i) => ({
    groupId: ctx.groupId, companyId: ctx.companyId, ingestionId: ingestion.id, sourceId: ingestion.sourceId, sourceType: ingestion.sourceKind,
    sourceVersion: ingestion.sourceVersion, chunkIndex: c.index, contentRedacted: c.text, contentHash: crypto.createHash('sha256').update(c.text, 'utf8').digest('hex'),
    tokensCount: Math.max(1, c.tokens), classification: ingestion.classification, effectiveFrom: meta.effectiveFrom, effectiveUntil: meta.effectiveUntil || null,
    requiredPermission: meta.requiredPermission, ownerScope: meta.ownerScope || 'COMPANY', ownerUserId: meta.ownerUserId || null,
    embedding: vectors[i].embedding, embeddingNorm: vectors[i].norm, embeddingModel: model, status: 'ACTIVE',
  }));
}

/** writeChunks(ctx, ingestion, meta, chunks, vectors, model, transaction) => número de chunks gravados. */
async function writeChunks(ctx, ingestion, meta, chunks, vectors, model, transaction) {
  const rows = buildRows(ctx, ingestion, meta, chunks, vectors, model);
  rows.forEach(assertChunkMetadata);
  await repo.supersedeOlder(ctx, ingestion.sourceKind, ingestion.sourceId, ingestion.sourceVersion, transaction);
  await repo.insertAll(rows, transaction);
  return rows.length;
}

module.exports = { writeChunks, assertChunkMetadata, buildRows };
