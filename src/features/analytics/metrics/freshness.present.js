'use strict';

/**
 * M9-D609 (3.2) — regras de exibição: aplica a freshness ao snapshot antes de ele sair numa resposta. Dado velho nunca se passa por atual:
 *  - nunca atualizado (source_snapshot_at nulo) ou carimbo da fonte no futuro além da folga (relógio adiantado): status INCOMPLETE, sem valor;
 *  - EXPIRED: status DEGRADED e value nulo (o Front mostra "Dado antigo, não use para decidir", nunca o número);
 *  - STALE: status STALE e o valor com o selo "Desatualizado há X";
 *  - FRESH: o status gravado no snapshot.
 * Um status pior gravado no snapshot (DEGRADED, INCOMPLETE) nunca é melhorado. Leitura de dia passado (histórica) devolve o registro como foi
 * gravado, com a freshness da época. O relógio é o injetável do BI.
 * DI-BI-2: para hoje, a idade conta da leitura mais recente da fonte que CONFIRMOU o mesmo número (snapshotConfirmation), não do primeiro cálculo do dia.
 */
const clock = require('./clock');
const { STATES, computeFreshness, maxStalenessOf } = require('./freshness');
const { readFreshnessParams } = require('./freshness.settings');
const { assessQuality } = require('../quality/status.service');
const { worstStatus, isUnreliable } = require('../quality/status.priority');
const { effectiveTimes } = require('./snapshotConfirmation');

const WORSE = new Set(['DEGRADED', 'INCOMPLETE']);

function resolveStatus(recorded, state) {
  if (state === STATES.UNKNOWN) return 'INCOMPLETE';
  if (state === STATES.EXPIRED) return 'DEGRADED';
  if (state === STATES.STALE && !WORSE.has(recorded)) return 'STALE';
  return recorded;
}

/**
 * { value, status, valueReliable, quality, freshness }: `rawValue` é o valor gravado (texto) e `snapshot` a linha de metric_snapshots. M9-D697: o pior entre
 * a freshness, o status gravado, os checks de qualidade e os componentes vence; DEGRADED e INCOMPLETE nunca saem com valor (nulo != 0).
 */
async function presentSnapshot({ definition, version, snapshot, rawValue, asOfDate, scope, transaction, visited, now = clock.now() }) {
  const params = await readFreshnessParams(scope, transaction);
  const historical = asOfDate < clock.businessToday(now);
  const times = historical ? { sourceSnapshotAt: snapshot.source_snapshot_at, refreshedAt: snapshot.refreshed_at, confirmedAt: null } : await effectiveTimes(snapshot, transaction);
  const freshness = computeFreshness({
    asOfDate, sourceSnapshotAt: times.sourceSnapshotAt, refreshedAt: times.refreshedAt,
    maxStalenessMinutes: maxStalenessOf(version.refresh_policy, definition.domain, params), factor: params.factor, now, historical, futureToleranceMinutes: params.futureToleranceMinutes,
  });
  const base = historical && !freshness.futureStamp ? snapshot.status : resolveStatus(snapshot.status, freshness.state);
  const assessed = await assessQuality({ metricCode: definition.metric_code, scope, asOfDate, historical, transaction, visited });
  const status = worstStatus(base, assessed.status);
  const unreliable = isUnreliable(status);
  const hidden = unreliable || (freshness.futureStamp || (!historical && (freshness.state === STATES.UNKNOWN || freshness.state === STATES.EXPIRED)));
  if (times.confirmedAt) freshness.recordedSourceAt = snapshot.source_snapshot_at; // o número é o do snapshot gravado nesse instante; a fonte foi relida e confirmou o mesmo depois
  return {
    value: hidden ? null : rawValue, status, valueReliable: !unreliable, freshness,
    quality: { degradedBy: assessed.degradedBy, inheritedFrom: assessed.inheritedFrom },
  };
}

module.exports = { presentSnapshot, resolveStatus };
