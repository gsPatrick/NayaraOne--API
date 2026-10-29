'use strict';

const { CLASSES, ACTIONS } = require('./dlp.constants');
const errors = require('./dlp.errors');

const BOOLEANS = ['allowed', 'requireJustification', 'requireMfa', 'requireAudit', 'requireWatermark', 'requireMask'];
const FIELDS = [...BOOLEANS, 'requirePermission', 'maxRows', 'maxExpiryHours'];
const SNAKE = {
  require_justification: 'requireJustification', require_mfa: 'requireMfa', require_audit: 'requireAudit', require_watermark: 'requireWatermark',
  require_mask: 'requireMask', require_permission: 'requirePermission', max_rows: 'maxRows', max_expiry_hours: 'maxExpiryHours',
};
const PERMISSION_CODE = /^[a-z][a-z0-9-]*(:[a-z0-9-]+)+$/;
const MAX_ROWS_LIMIT = 100000000;
const MAX_EXPIRY_LIMIT = 8760;

/** Classe e ação da rota (maiúsculas ou minúsculas); fora do vocabulário = 400 GOV_DLP_POLICY_INVALID. */
function parseKey(classification, action) {
  const c = String(classification || '').toUpperCase();
  const a = String(action || '').toUpperCase();
  if (!CLASSES.includes(c) || !ACTIONS.includes(a)) throw errors.policyInvalid({ classification, action });
  return { classification: c, action: a };
}

const isNullish = (value) => value === null || value === '';

/**
 * Corpo do PUT (camelCase ou snake_case). Só os campos informados mudam; campo desconhecido ou de tipo errado é 400. `requirePermission`, `maxRows` e
 * `maxExpiryHours` aceitam null (sem exigência / sem teto / sem expiração).
 */
function parsePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw errors.policyFieldInvalid('corpo');
  const patch = {};
  for (const [rawName, value] of Object.entries(body)) {
    const name = SNAKE[rawName] || rawName;
    if (value === undefined) continue;
    if (!FIELDS.includes(name)) throw errors.policyFieldInvalid(rawName);
    if (BOOLEANS.includes(name)) {
      if (typeof value !== 'boolean') throw errors.policyFieldInvalid(rawName);
      patch[name] = value;
    } else if (name === 'requirePermission') {
      if (!isNullish(value) && !(typeof value === 'string' && PERMISSION_CODE.test(value) && value.length <= 100)) throw errors.policyFieldInvalid(rawName);
      patch[name] = isNullish(value) ? null : value;
    } else {
      const limit = name === 'maxRows' ? MAX_ROWS_LIMIT : MAX_EXPIRY_LIMIT;
      if (!isNullish(value) && !(Number.isInteger(value) && value >= 1 && value <= limit)) throw errors.policyFieldInvalid(rawName);
      patch[name] = isNullish(value) ? null : value;
    }
  }
  return patch;
}

module.exports = { parseKey, parsePatch, FIELDS };
