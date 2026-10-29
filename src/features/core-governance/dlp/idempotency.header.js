'use strict';

const crypto = require('node:crypto');
const { govError } = require('../governance.errors');

const KEY_MIN = 8;
const KEY_MAX = 100;

const required = () => govError(400, 'GOV_IDEMPOTENCY_KEY_REQUIRED', 'Envie o cabeçalho Idempotency-Key.');
const invalid = () => govError(400, 'GOV_IDEMPOTENCY_KEY_INVALID', `A chave de idempotência deve ter de ${KEY_MIN} a ${KEY_MAX} caracteres.`);

/** Valida a chave: ausente é 400 GOV_IDEMPOTENCY_KEY_REQUIRED, fora de 8 a 100 caracteres 400 GOV_IDEMPOTENCY_KEY_INVALID. Devolve a chave sem espaços nas pontas. */
function assertKey(key) {
  if (typeof key !== 'string' || !key.trim()) throw required();
  const clean = key.trim();
  if (clean.length < KEY_MIN || clean.length > KEY_MAX) throw invalid();
  return clean;
}

/** Middleware das rotas que exigem a chave (POST /exports, POST /dlp/share-links; lista fechada de M9-D843 §3.3). */
function requireIdempotencyKey(req, _res, next) {
  try { assertKey(req.get('Idempotency-Key')); return next(); } catch (error) { return next(error); }
}

/**
 * A chave é de cada usuário e de cada tipo de pedido (M9-D822 §6): vai ao banco com o prefixo do usuário e o espaço (`e` exportação, `s` link), para duas pessoas ou
 * dois pedidos diferentes usarem a mesma chave sem se cruzar no índice único da empresa.
 */
function scopedKey(actorUserId, key, space) {
  return `${crypto.createHash('sha256').update(String(actorUserId)).digest('hex').slice(0, 12)}:${space}:${assertKey(key)}`;
}

module.exports = { assertKey, requireIdempotencyKey, scopedKey };
