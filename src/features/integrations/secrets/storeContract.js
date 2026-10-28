'use strict';

const AppError = require('../../../utils/AppError');
const { assertRefFormat } = require('./secretRef');

/**
 * Porta SecretStore (M9-D202 3.1): única forma de ler segredo.
 *   get(ref, {version?})            -> { value: SecretValue, version, expiresAt }
 *   put(ref, value, meta)           -> version   (meta: expiresAt, candidate, graceMs)
 *   rotate(ref, version, {graceMs}) -> version   (promove a candidata; a anterior entra em graça)
 *   describe(ref)                   -> { version, createdAt, rotatedAt, expiresAt }   (nunca o valor)
 *   revoke(ref, version)            -> void
 *   getAcceptedVersions(ref)        -> [{ value, version, expiresAt }]  (corrente + graça, para webhooks em voo)
 * `driver` diz qual implementação é (a regra do BANK em produção depende disso).
 */
const MAX_VALUE_LENGTH = 8192;
const METHODS = ['get', 'put', 'rotate', 'describe', 'revoke', 'getAcceptedVersions'];

function assertStoreShape(store) {
  const faltando = METHODS.filter((m) => typeof store?.[m] !== 'function');
  if (!store?.driver || faltando.length) throw AppError.internal(`SecretStore incompleto: falta ${faltando.join(', ') || 'driver'}.`, 'INTEGRATION_SECRET_STORE_CONFIG');
}

function assertValue(valor) {
  if (typeof valor !== 'string' || valor.length === 0 || valor.length > MAX_VALUE_LENGTH) {
    throw AppError.badRequest(`O segredo deve ser um texto de 1 a ${MAX_VALUE_LENGTH} caracteres.`, 'VALIDATION_ERROR');
  }
}

module.exports = { METHODS, MAX_VALUE_LENGTH, assertStoreShape, assertValue, assertRef: assertRefFormat };
