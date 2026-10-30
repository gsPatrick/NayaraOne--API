'use strict';

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Chave do registro como a API devolve (camelCase). `liveValue` (quando existir) é o valor vivo da configuração da empresa absorvida. */
function viewOf(row, liveValue) {
  return {
    id: row.id, key: row.key, kind: row.kind, value: liveValue === undefined ? row.value : liveValue, valueType: row.value_type, allowedValues: row.allowed_values,
    ownerUserId: row.owner_user_id, scope: row.scope, scopeRef: row.scope_ref, risk: row.risk, version: row.version, validFrom: iso(row.valid_from), validUntil: iso(row.valid_until),
    temporary: row.temporary, description: row.description, isKillSwitch: row.is_kill_switch, probe: row.probe === undefined ? null : row.probe, verificationState: row.is_kill_switch && row.verification_state ? row.verification_state : null, state: row.state, source: row.source, updatedBy: row.updated_by, updatedAt: iso(row.updated_at),
  };
}

/** Estado de uma chave para a auditoria e para a foto de versão (sem o que não muda de significado). */
const snapshotOf = (row, liveValue) => ({
  value: liveValue === undefined ? row.value : liveValue, ownerUserId: row.owner_user_id, scope: row.scope, scopeRef: row.scope_ref, risk: row.risk, version: row.version,
  validFrom: iso(row.valid_from), validUntil: iso(row.valid_until), temporary: row.temporary, state: row.state, description: row.description,
});

module.exports = { viewOf, snapshotOf, iso };
