'use strict';

/**
 * M9-D624 — grava os snapshots de um KPI financeiro: o valor principal (dimensão vazia) e uma linha por dimensão da fórmula. Snapshot é
 * imutável (M9-D600): se já existe revisão com o mesmo valor, status e hash de cálculo nada é gravado; se mudou durante o dia, entra a
 * revisão seguinte (a data-base de hoje é recalculada a cada atualização do read model). Devolve quantas linhas entraram.
 */
const store = require('../../metricStore.service');

// numeric(20,4) devolve "14.0000": compara sem zeros à direita.
const plain = (v) => (v === null || v === undefined ? '' : String(v)).replace(/^(-?\d+\.\d*?)0+$/, '$1').replace(/\.$/, '');

async function writeSnapshot(base, dimensionKey, value, transaction) {
  const input = { ...base, dimensionKey, valueNumeric: value };
  const revisions = await store.listSnapshotRevisions({
    metricId: base.metricId, metricVersionId: base.metricVersionId, scopeType: base.scopeType, scopeId: base.scopeId, asOfDate: base.asOfDate, dimensionKey,
  }, transaction);
  const last = revisions[revisions.length - 1];
  if (!last) {
    await store.recordSnapshot(input, transaction);
    return 1;
  }
  if (last.calc_hash === base.calcHash && last.status === base.status && plain(last.value_numeric) === plain(value)) return 0;
  await store.recordSnapshotRevision(input, transaction);
  return 1;
}

/** Grava a lista de entradas (principal + dimensões) e devolve quantas linhas entraram. */
async function writeSnapshotInputs(inputs, transaction) {
  let written = 0;
  for (const input of inputs) written += await writeSnapshot(input, input.dimensionKey, input.valueNumeric, transaction);
  return written;
}

module.exports = { writeSnapshotInputs };
