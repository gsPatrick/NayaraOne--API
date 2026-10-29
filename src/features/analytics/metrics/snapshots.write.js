'use strict';

/**
 * M9-D609 (3.3 e 6) — grava os snapshots de UMA métrica numa data-base, na transação já aberta pelo chamador (uma por métrica). Exige o
 * `sourceRefs` montado por buildSourceRefs (M9-D611) com filterHash e count em todo snapshot, e que a versão calculada seja a vigente na
 * data-base. Snapshot já existente (de qualquer revisão) nunca é regravado: é a imutabilidade (M9-D600) e a idempotência do job.
 */
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const store = require('../metricStore.service');

const HASH_RE = /^[0-9a-f]{64}$/;
const refsOk = (refs) => Array.isArray(refs) && refs.length > 0
  && refs.every((r) => r && HASH_RE.test(String(r.filterHash || '')) && typeof r.filterSignature === 'string' && Number.isInteger(r.count) && r.count >= 0);

function assertEntry(entry, versionAtDate) {
  if (!entry.inputs.length) throw AppError.badRequest('O provedor não devolveu nenhum valor para a métrica.', 'ANALYTICS_SNAPSHOT_EMPTY');
  for (const input of entry.inputs) {
    if (!refsOk(input.sourceRefs)) {
      throw AppError.badRequest('Todo snapshot do BI exige o sourceRefs com filterHash assinado e count (buildSourceRefs).', 'ANALYTICS_SNAPSHOT_SOURCE_REFS_REQUIRED');
    }
    if (!versionAtDate || input.metricVersionId !== versionAtDate.id) {
      throw AppError.conflict('A versão calculada não é a vigente na data-base do snapshot.', 'ANALYTICS_SNAPSHOT_VERSION_MISMATCH');
    }
  }
}

/** { written, existing }. */
async function writeMetricSnapshots({ entry, metricId, asOfDate, capturedLate }, transaction) {
  assertEntry(entry, await store.getMetricVersionAt(metricId, asOfDate, transaction));
  let written = 0;
  let existing = 0;
  for (const input of entry.inputs) {
    const key = { metricId, scopeType: input.scopeType, scopeId: input.scopeId, asOfDate, dimensionKey: input.dimensionKey || '' };
    if ((await store.listSnapshotRevisions(key, transaction)).length) { existing += 1; continue; }
    try {
      await sequelize.transaction({ transaction }, (savepoint) => store.recordSnapshot({ ...input, asOfDate, capturedLate }, savepoint));
      written += 1;
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'ANALYTICS_SNAPSHOT_DUPLICATE') throw err; // corrida com a gravação ao vivo do refresh: o que ganhou vale
      existing += 1;
    }
  }
  return { written, existing };
}

module.exports = { writeMetricSnapshots, refsOk };
