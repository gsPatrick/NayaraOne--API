'use strict';

/**
 * M9-D697 (3.1) — estados de qualidade de uma métrica (campo `status` da resposta): OK, STALE, DEGRADED, INCOMPLETE. `EXPIRED` NÃO é estado: é
 * `freshness.state` e resulta em DEGRADED. Prioridade quando mais de um se aplica: INCOMPLETE > DEGRADED > STALE > OK (o pior vence).
 */
const STATUS_ENUM = Object.freeze(['OK', 'STALE', 'DEGRADED', 'INCOMPLETE']);
const RANK = Object.freeze({ OK: 0, STALE: 1, DEGRADED: 2, INCOMPLETE: 3 });

const rankOf = (status) => (status in RANK ? RANK[status] : 0);

/** O pior dos estados informados (sem argumento, OK). */
function worstStatus(...statuses) {
  let worst = 'OK';
  for (const s of statuses) if (rankOf(s) > rankOf(worst)) worst = s;
  return worst;
}

/** Valor não confiável: DEGRADED e INCOMPLETE nunca saem como número (nulo != 0). */
const isUnreliable = (status) => status === 'DEGRADED' || status === 'INCOMPLETE';

module.exports = { STATUS_ENUM, worstStatus, isUnreliable };
