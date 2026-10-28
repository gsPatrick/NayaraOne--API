'use strict';

const crypto = require('node:crypto');

/** JSON canônico (chaves em ordem alfabética em qualquer profundidade): a mesma definição sempre dá o mesmo hash. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** Hash do conteúdo da versão (tudo que a define; mesma definição, mesmo hash). */
function definitionHash(d) {
  return sha256(canonicalJson({
    triggerType: d.triggerType, triggerConfig: d.triggerConfig, conditions: d.conditions, conditionsEmptyReason: d.conditionsEmptyReason || null,
    actions: d.actions, cooldown: d.cooldown, frequencyCap: d.frequencyCap, validFrom: d.validFrom ? new Date(d.validFrom).toISOString() : null,
    validUntil: d.validUntil ? new Date(d.validUntil).toISOString() : null, riskLevel: d.riskLevel,
  }));
}

/** Linha do banco -> definição em camelCase (o que o corpo da API usa). */
function rowToDefinition(row) {
  return {
    triggerType: row.trigger_type, triggerConfig: row.trigger_config, conditions: row.conditions, conditionsEmptyReason: row.conditions_empty_reason,
    actions: row.actions, cooldown: row.cooldown, frequencyCap: row.frequency_cap, validFrom: row.valid_from, validUntil: row.valid_until, riskLevel: row.risk_level,
  };
}

function versionDto(row) {
  return { id: row.id, versionNo: row.version_no, status: row.status, contentHash: row.content_hash, ...rowToDefinition(row) };
}

function flowDto(flow) {
  return { id: flow.id, code: flow.code, name: flow.name, ownerUserId: flow.owner_user_id, riskLevel: flow.risk_level, status: flow.status, publishedVersionId: flow.published_version_id };
}

module.exports = { definitionHash, rowToDefinition, versionDto, flowDto };
