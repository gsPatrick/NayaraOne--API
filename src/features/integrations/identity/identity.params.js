'use strict';

const { getSetting } = require('../../settings/settings.service');
const { safeAlgorithms } = require('../../../shared/identity/jwtStrict');

const PADROES = Object.freeze({
  localFallbackEnabled: true, localFallbackAdminEnabled: true, clockToleranceS: 60, jwksCacheTtlS: 300, allowedAlgorithms: 'RS256', adminRoles: 'ADMIN',
});
const inteiro = (v, padrao, min) => (Number.isInteger(v) && v >= min ? v : padrao);
const booleano = (v, padrao) => (typeof v === 'boolean' ? v : (v === 'true' ? true : (v === 'false' ? false : padrao)));
const lista = (texto) => String(texto || '').split(',').map((s) => s.trim()).filter(Boolean);

/** Parâmetros da identidade da empresa (padrões do parametros.csv quando não configurados). */
async function readIdentityParams(tenant, transaction) {
  const [fb, fbAdmin, tol, ttl, algs, roles] = await Promise.all([
    getSetting('integration.identity.local_fallback_enabled', tenant, transaction, PADROES.localFallbackEnabled),
    getSetting('integration.identity.local_fallback_admin_enabled', tenant, transaction, PADROES.localFallbackAdminEnabled),
    getSetting('integration.identity.clock_tolerance_s', tenant, transaction, PADROES.clockToleranceS),
    getSetting('integration.identity.jwks_cache_ttl_s', tenant, transaction, PADROES.jwksCacheTtlS),
    getSetting('integration.identity.allowed_algorithms', tenant, transaction, PADROES.allowedAlgorithms),
    getSetting('integration.identity.local_fallback_admin_roles', tenant, transaction, PADROES.adminRoles),
  ]);
  const algorithms = safeAlgorithms(lista(algs));
  return {
    localFallbackEnabled: booleano(fb, PADROES.localFallbackEnabled),
    localFallbackAdminEnabled: booleano(fbAdmin, PADROES.localFallbackAdminEnabled),
    clockToleranceS: inteiro(tol, PADROES.clockToleranceS, 0),
    jwksCacheTtlS: inteiro(ttl, PADROES.jwksCacheTtlS, 10),
    algorithms: algorithms.length ? algorithms : lista(PADROES.allowedAlgorithms),
    adminRoles: lista(roles).length ? lista(roles) : lista(PADROES.adminRoles),
  };
}

module.exports = { readIdentityParams, PADROES };
