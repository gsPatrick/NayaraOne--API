'use strict';

const { File, KnowledgeEntry } = require('../../../models');
const { resolveFileOwnership } = require('../../files/fileAccess.service');
const chunks = require('./chunks.repository');
const V = require('./ingestion.input');
const { readRagParams } = require('./retrieval.params');
const { DEFAULT_PERMISSION, CLASSIFICATION_RANK } = require('./retrieval.constants');

/**
 * Reconciliação dos chunks com a origem (M9-D023): quando a permissão ou a classificação da origem muda, copia a mudança para os chunks
 * ACTIVE (`required_permission`, `classification`, `owner_scope`, `owner_user_id`) em até `ia.rag.reconciliar_minutos` (o job acorda de
 * minuto em minuto; quem decide a hora é o parâmetro da empresa; M9-D024: o fim da vigência do conhecimento também é copiado). Origem apagada, conhecimento que deixou de ser homologado, ou
 * classificação RESTRICTED com `ia.rag.indexar_restricted` Desligado: os chunks saem da busca (REVOKED). Até a reconciliação rodar, a
 * dupla checagem na leitura (doubleCheck) já impede o vazamento.
 */
const stricter = (a, b) => (!a ? b : !b ? a : (CLASSIFICATION_RANK[a] >= CLASSIFICATION_RANK[b] ? a : b));

async function currentFile(ctx, sourceId, transaction) {
  const file = await File.findByPk(sourceId, { transaction });
  if (!file) return null;
  const ownership = await resolveFileOwnership(file.id, transaction);
  const perms = [...ownership.permissions].sort();
  const owned = ownership.hasOwner && perms.length > 0;
  const owner = file.uploadedByUserId || file.createdBy || null;
  return {
    classification: stricter(file.classification || null, ownership.restricted ? 'RESTRICTED' : null), requiredPermission: owned ? perms[0] : DEFAULT_PERMISSION,
    ownerScope: owned ? 'COMPANY' : 'USER', ownerUserId: owned ? null : owner,
  };
}

async function currentKnowledge(ctx, sourceId, transaction) {
  const entry = await KnowledgeEntry.findOne({ where: { id: sourceId, companyId: ctx.companyId }, transaction });
  if (!entry || entry.status !== 'HOMOLOGATED' || !entry.isActive) return null;
  return { classification: entry.classification, requiredPermission: DEFAULT_PERMISSION, ownerScope: 'COMPANY', ownerUserId: null, effectiveUntil: entry.validUntil || null };
}

const time = (v) => (v ? new Date(v).getTime() : null);
const differs = (chunk, now) => ['classification', 'requiredPermission', 'ownerScope', 'ownerUserId'].some((k) => (chunk[k] || null) !== (now[k] || null))
  || ('effectiveUntil' in now && time(chunk.effectiveUntil) !== time(now.effectiveUntil));

async function reconcileSource(ctx, source, params, transaction) {
  if (source.sourceType === 'URL') return 'same';
  const now = source.sourceType === 'FILE' ? await currentFile(ctx, source.sourceId, transaction) : await currentKnowledge(ctx, source.sourceId, transaction);
  if (!now || (now.classification === 'RESTRICTED' && !params.indexRestricted)) {
    await chunks.retractSource(ctx, source.sourceType, source.sourceId, 'REVOKED', transaction);
    return 'retracted';
  }
  const sample = await chunks.sampleActive(ctx, source.sourceType, source.sourceId, transaction);
  if (!sample) return 'same';
  const patch = { ...now, classification: now.classification || sample.classification };
  if (!differs(sample, patch)) return 'same';
  await chunks.updateMetadata(ctx, source.sourceType, source.sourceId, patch, transaction);
  return 'updated';
}

/** reconcileChunks(ctx, transaction) => { sources, updated, retracted }. */
async function reconcileChunks(ctx, transaction) {
  V.ctxOk(ctx);
  const params = await readRagParams(ctx, transaction);
  const summary = { sources: 0, updated: 0, retracted: 0 };
  for (const source of await chunks.activeSources(ctx, transaction)) {
    const result = await reconcileSource(ctx, source, params, transaction);
    summary.sources += 1;
    if (result === 'updated') summary.updated += 1;
    if (result === 'retracted') summary.retracted += 1;
  }
  return summary;
}

module.exports = { reconcileChunks };
