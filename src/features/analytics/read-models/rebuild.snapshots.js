'use strict';

/**
 * M9-D608 (3.4) — o rebuild NUNCA apaga metric_snapshots. Se ele corrige um valor do passado, o snapshot antigo fica e uma NOVA linha
 * entra com o mesmo metric_version_id e data-base, revision_no + 1 e recalculated = true (recordSnapshotRevision, M9-D600). O read model
 * declara as correções em `rebuild.corrections({ companyId, groupId, snapshotAt, transaction })`, que devolve entradas de snapshot já
 * calculadas com a fórmula da versão da época; só entra revisão quando o valor ou o hash do cálculo mudou em relação à última revisão.
 */
const store = require('../metricStore.service');

// 119000 e 119000.0000 são o mesmo valor: o banco devolve a escala da coluna numeric.
const plain = (v) => (v === null || v === undefined ? '' : String(v)).replace(/^(-?\d+\.\d*?)0+$/, '$1').replace(/\.$/, '');
const same = (last, input) => last.calc_hash === input.calcHash
  && plain(last.value_numeric ?? last.value_text) === plain(input.valueNumeric ?? input.valueText)
  && last.status === (input.status || 'OK');

async function applyCorrections(def, scope, snapshotAt, transaction) {
  if (!def.rebuild || typeof def.rebuild.corrections !== 'function') return { revised: 0, unchanged: 0 };
  const inputs = await def.rebuild.corrections({ ...scope, snapshotAt, transaction });
  let revised = 0;
  let unchanged = 0;
  for (const input of inputs || []) {
    const revisions = await store.listSnapshotRevisions({
      metricId: input.metricId, metricVersionId: input.metricVersionId, scopeType: input.scopeType, scopeId: input.scopeId, asOfDate: input.asOfDate, dimensionKey: input.dimensionKey || '',
    }, transaction);
    const last = revisions[revisions.length - 1];
    if (last && same(last, input)) {
      unchanged += 1;
    } else if (last) {
      await store.recordSnapshotRevision({ ...input, groupId: scope.groupId, companyId: input.scopeType === 'GROUP' ? null : scope.companyId, sourceSnapshotAt: snapshotAt }, transaction);
      revised += 1;
    } // sem snapshot anterior não há o que corrigir: a primeira gravação é do cálculo diário, não do rebuild
  }
  return { revised, unchanged };
}

module.exports = { applyCorrections };
