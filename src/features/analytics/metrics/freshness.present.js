'use strict';

/**
 * M9-D609 (3.2) — regras de exibição: aplica a freshness ao snapshot antes de ele sair numa resposta. Dado velho nunca se passa por atual:
 *  - nunca atualizado (source_snapshot_at nulo): status INCOMPLETE, sem valor;
 *  - EXPIRED: status DEGRADED e value nulo (o Front mostra "Dado antigo, não use para decidir", nunca o número);
 *  - STALE: status STALE e o valor com o selo "Desatualizado há X";
 *  - FRESH: o status gravado no snapshot.
 * Um status pior gravado no snapshot (DEGRADED, INCOMPLETE) nunca é melhorado. Leitura de dia passado (histórica) devolve o registro como foi
 * gravado, com a freshness da época. O relógio é o injetável do BI.
 */
const clock = require('./clock');
const { STATES, computeFreshness, maxStalenessOf } = require('./freshness');
const { readFreshnessParams } = require('./freshness.settings');

const WORSE = new Set(['DEGRADED', 'INCOMPLETE']);

function resolveStatus(recorded, state) {
  if (state === STATES.UNKNOWN) return 'INCOMPLETE';
  if (state === STATES.EXPIRED) return 'DEGRADED';
  if (state === STATES.STALE && !WORSE.has(recorded)) return 'STALE';
  return recorded;
}

/** { value, status, freshness }: `rawValue` é o valor gravado (texto) e `snapshot` a linha de metric_snapshots. */
async function presentSnapshot({ definition, version, snapshot, rawValue, asOfDate, scope, transaction, now = clock.now() }) {
  const params = await readFreshnessParams(scope, transaction);
  const historical = asOfDate < clock.businessToday(now);
  const freshness = computeFreshness({
    asOfDate, sourceSnapshotAt: snapshot.source_snapshot_at, refreshedAt: snapshot.refreshed_at,
    maxStalenessMinutes: maxStalenessOf(version.refresh_policy, definition.domain, params), factor: params.factor, now, historical,
  });
  if (historical) return { value: rawValue, status: snapshot.status, freshness };
  const status = resolveStatus(snapshot.status, freshness.state);
  const hidden = freshness.state === STATES.UNKNOWN || freshness.state === STATES.EXPIRED;
  return { value: hidden ? null : rawValue, status, freshness };
}

module.exports = { presentSnapshot, resolveStatus };
