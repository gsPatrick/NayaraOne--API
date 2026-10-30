'use strict';

const { CHANNELS } = require('./publications/adapters/channels');
const { SCOPES } = require('./killswitch.constants');
const { readReasonMin } = require('./killswitch.settings');
const errors = require('./killswitch.errors');
const { assertKnownBodyFields } = require('./marketing.body');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * Corpo do POST /marketing/kill-switch: `{ scope, targetId?, active, reason, compromised? }`. Ordem das recusas: formato (400 MKT_KILL_SWITCH_INPUT_INVALID), motivo
 * (400 MKT_REASON_REQUIRED, mínimo em marketing.killswitch.motivo_min_caracteres), conta comprometida fora de CHANNEL (422 MKT_KILL_SWITCH_COMPROMISED_SCOPE) e alvo
 * inexistente (404, na busca do alvo). Canal e id vêm normalizados (canal em maiúsculas; id em minúsculas).
 */
async function parseChange(body, tenant, transaction) {
  const b = isObject(body) ? body : {};
  assertKnownBodyFields(b, ['scope', 'targetId', 'active', 'reason', 'compromised', 'confirmation']); // M9-D435: campo desconhecido é 400 MKT_VALIDATION
  const scope = typeof b.scope === 'string' ? b.scope.trim().toUpperCase() : '';
  if (!SCOPES[scope]) throw errors.inputInvalid({ field: 'scope', allowed: Object.keys(SCOPES) });
  if (typeof b.active !== 'boolean') throw errors.inputInvalid({ field: 'active' });
  if (b.compromised !== undefined && typeof b.compromised !== 'boolean') throw errors.inputInvalid({ field: 'compromised' });
  if (scope === SCOPES.GLOBAL && b.targetId !== undefined && b.targetId !== null && b.targetId !== '') throw errors.inputInvalid({ field: 'targetId', reason: 'o escopo GLOBAL não tem alvo' });
  if (scope !== SCOPES.GLOBAL && (typeof b.targetId !== 'string' || !b.targetId.trim())) throw errors.inputInvalid({ field: 'targetId' });
  const min = await readReasonMin(tenant, transaction);
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (reason.length < min) throw errors.reasonRequired(min);
  if (b.compromised === true && scope !== SCOPES.CHANNEL) throw errors.compromisedScope();
  let targetId = null;
  if (scope === SCOPES.CHANNEL) targetId = b.targetId.trim().toUpperCase();
  else if (scope !== SCOPES.GLOBAL) targetId = b.targetId.trim().toLowerCase();
  if (scope === SCOPES.CHANNEL && !CHANNELS.includes(targetId)) throw errors.targetNotFound({ scope, targetId });
  if ([SCOPES.CAMPAIGN, SCOPES.AUTOMATION].includes(scope) && !UUID_RE.test(targetId)) throw errors.targetNotFound({ scope, targetId });
  return { scope, targetId, active: b.active, reason, compromised: b.compromised === true };
}

module.exports = { parseChange };
