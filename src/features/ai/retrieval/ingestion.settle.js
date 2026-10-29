'use strict';

const repo = require('./ingestion.repository');
const { writeChunks } = require('./chunks.write');
const { auditIngestion } = require('./ingestion.audit');
const { STEPS } = require('./retrieval.constants');

/**
 * Grava o resultado do pipeline (M9-D022). Linha nova (pedido direto) ou a linha PENDING que já existia (conhecimento homologado,
 * processada pelo job). Estado final: INDEXED (com os chunks, na mesma transação, e a versão anterior da fonte SUPERSEDED), REJECTED
 * ou FAILED, sempre com a etapa e o código. Cada gravação deixa a trilha de auditoria antes/depois, sem texto do documento.
 */
async function settle(ctx, desc, input, pending, result, transaction) {
  const track = result.track;
  const version = pending ? pending.sourceVersion : (desc.version || await repo.nextVersion(ctx, desc.kind, desc.sourceId, transaction));
  const stopped = Boolean(result.stop);
  const fields = {
    status: stopped ? result.stop.status : 'INDEXED', step: stopped ? result.stop.step : STEPS.done, errorCode: stopped ? result.stop.code : null,
    contentHash: track.contentHash, classification: desc.classification || null, secretsRemoved: track.secretsRemoved,
    activeContentDiscarded: track.activeContentDiscarded, chunksCount: stopped ? 0 : result.chunks.length, finishedAt: new Date(),
  };
  const before = pending ? pending.get({ plain: true }) : null;
  const row = pending
    ? await pending.update(fields, { transaction })
    : await repo.create(ctx, { sourceKind: desc.kind, sourceRef: desc.sourceRef, sourceId: desc.sourceId, sourceVersion: version, ...fields }, transaction);
  if (!stopped) await writeChunks(ctx, row, desc, result.chunks, result.vectors, result.model, transaction);
  await auditIngestion(ctx, `ai.ingestion.${fields.status.toLowerCase()}`, row, before, stopped ? `Ingestão ${fields.status} na etapa ${fields.step}: ${fields.errorCode}.` : `Ingestão concluída com ${fields.chunksCount} chunks.`, transaction);
  return row;
}

module.exports = { settle };
