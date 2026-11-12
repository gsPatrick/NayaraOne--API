'use strict';

const crypto = require('node:crypto');

// JSON canônico (chaves em ordem) para o mesmo corpo dar o mesmo hash, qualquer que seja a ordem dos campos. Iterativo desde a rodada 7 (DI-M9R-18).
const { canonicalJson: canonical } = require('../../../../utils/canonicalJson');

// M9-D852: o corpo `confirmation` (impactToken novo a cada tentativa) não faz parte do que a chave de idempotência protege.
function withoutConfirmation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('confirmation' in body)) return body;
  const { confirmation: _confirmation, ...rest } = body;
  return rest;
}

const bodyHash = (body) => crypto.createHash('sha256').update(canonical(body === undefined ? {} : withoutConfirmation(body))).digest('hex');

module.exports = { canonical, bodyHash };
