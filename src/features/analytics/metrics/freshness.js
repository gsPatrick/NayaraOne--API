'use strict';

/**
 * M9-D614 (regra 5) — `freshness` presente em toda resposta de métrica. Aqui só o que o snapshot sabe (data-base, instante da fonte e
 * da gravação); o status de frescor e o limite de atraso por métrica são da M9-D609, que evolui esta função.
 */
function buildFreshness(asOfDate, snapshot) {
  return { asOfDate, sourceSnapshotAt: snapshot.source_snapshot_at, refreshedAt: snapshot.refreshed_at };
}

module.exports = { buildFreshness };
