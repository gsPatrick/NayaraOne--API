'use strict';

const AppError = require('../../../utils/AppError');
const { ALGORITMOS_CONHECIDOS } = require('../../../shared/identity/jwtStrict');

const LISTA_RE = /^[A-Za-z0-9]+(\s*,\s*[A-Za-z0-9]+)*$/;

/** Parâmetros da identidade e autenticação (M9-D242): só o dicionário de SETTINGS_SCHEMA; a leitura está em identity.params.js. */
const IDENTITY_SETTINGS_SCHEMA = Object.freeze({
  // INT-P089: chave geral do acesso local quando o provedor externo de identidade está fora.
  'integration.identity.local_fallback_enabled': { type: 'boolean' },
  // Livro/D242: administradores mantêm o login local (identity-local) quando o provedor externo cai (contingência INT-015).
  'integration.identity.local_fallback_admin_enabled': { type: 'boolean' },
  // Tolerância de relógio na validação de exp/nbf do token (livro: 60 s).
  'integration.identity.clock_tolerance_s': { type: 'integer', min: 0, max: 300 },
  // Por quanto tempo o conjunto de chaves públicas (JWKS) do provedor fica em cache.
  'integration.identity.jwks_cache_ttl_s': { type: 'integer', min: 10, max: 86400 },
  // Algoritmos de assinatura aceitos (nunca "none", mesmo que alguém o liste).
  'integration.identity.allowed_algorithms': {
    type: 'string',
    validate: (key, value) => {
      const itens = String(value).split(',').map((a) => a.trim());
      if (!LISTA_RE.test(String(value)) || itens.length > 6 || itens.some((a) => !ALGORITMOS_CONHECIDOS.includes(a))) {
        throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de até 6 algoritmos conhecidos (${ALGORITMOS_CONHECIDOS.join(', ')}) separados por vírgula.`, 'SETTING_INVALID_VALUE', { key, value });
      }
    },
  },
  // Papéis tratados como administrador para a regra de acesso local de contingência.
  'integration.identity.local_fallback_admin_roles': {
    type: 'string',
    validate: (key, value) => {
      if (!/^[A-Za-z0-9_ ]{2,60}(\s*,\s*[A-Za-z0-9_ ]{2,60}){0,9}$/.test(String(value).trim())) throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de 1 a 10 nomes de papel (como aparecem no cadastro de papéis) separados por vírgula.`, 'SETTING_INVALID_VALUE', { key, value });
    },
  },
});

module.exports = { IDENTITY_SETTINGS_SCHEMA };
