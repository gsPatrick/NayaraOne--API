'use strict';

const iso = (value) => (value ? new Date(value).toISOString() : null);

/** Linha do banco -> item da API. `isOverdue` é derivado aqui (OPEN e due_at no passado), nunca gravado. */
function presentItem(row, now) {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    title: row.title,
    ownerUserId: row.owner_user_id,
    ownerTeam: row.owner_team,
    dueAt: iso(row.due_at),
    endAt: iso(row.end_at),
    severity: row.severity,
    status: row.status,
    isOverdue: row.status === 'OPEN' && new Date(row.due_at).getTime() < now.getTime(),
    deepLink: row.deep_link,
    sourceKind: row.source_kind,
    cancelReason: row.cancel_reason,
  };
}

module.exports = { presentItem, iso };
