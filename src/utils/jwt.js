'use strict';

const jwt = require('jsonwebtoken');
const AppError = require('./AppError');

/**
 * Wrapper fino sobre `jsonwebtoken` — centraliza leitura dos segredos/TTL de env
 * e o formato de erro (AppError) usado por todo o restante da aplicação.
 * Ver src/documentacao/ENV_REFERENCE.md para as variáveis JWT_*.
 */

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw AppError.internal(
      `Variável de ambiente obrigatória ausente: ${name}.`,
      'JWT_CONFIG_MISSING'
    );
  }
  return value;
}

function signAccessToken(payload) {
  return jwt.sign(payload, requireEnv('JWT_ACCESS_SECRET'), {
    expiresIn: process.env.JWT_ACCESS_TTL || '15m',
  });
}

function signRefreshToken(payload) {
  return jwt.sign(payload, requireEnv('JWT_REFRESH_SECRET'), {
    expiresIn: process.env.JWT_REFRESH_TTL || '7d',
  });
}

function verifyAccessToken(token) {
  try {
    return jwt.verify(token, requireEnv('JWT_ACCESS_SECRET'));
  } catch (err) {
    throw AppError.unauthorized('Token de acesso inválido ou expirado.', 'INVALID_ACCESS_TOKEN');
  }
}

function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, requireEnv('JWT_REFRESH_SECRET'));
  } catch (err) {
    throw AppError.unauthorized('Refresh token inválido ou expirado.', 'INVALID_REFRESH_TOKEN');
  }
}

module.exports = { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken };
