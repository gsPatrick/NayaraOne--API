'use strict';

const jwt = require('jsonwebtoken');
const AppError = require('../../../../utils/AppError');
const catchAsync = require('../../../../utils/catchAsync');
const { inTenantTx } = require('../consumers/tenantTx');
const E = require('./clients.errors');
const repository = require('./clients.repository');
const { TYPE, verifyAnyToken, bearerOf, scopesOf } = require('./token');

/**
 * Autenticação das rotas /api-external/* (M9-D844 §3.2 e §3.4). Só aceita token de cliente (`typ = 'client'`): token de usuário e qualquer outro tipo é 401 GOV_AUTH_INVALID_TOKEN_TYPE;
 * token vencido é 401 GOV_TOKEN_EXPIRED. A CADA chamada confere a situação da credencial na empresa do token, sem cache: REVOKED é 401 GOV_CLIENT_DISABLED, mesmo com o JWT ainda válido.
 * Preenche `req.apiClient` = { clientId, groupId, companyId, scopes }.
 */
function readToken(req) {
  const token = bearerOf(req);
  if (!token) throw AppError.unauthorized('Token de acesso ausente.', 'MISSING_ACCESS_TOKEN');
  try {
    return verifyAnyToken(token);
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') {
      const unverified = jwt.decode(token);
      if (unverified && unverified.typ !== TYPE) throw E.invalidTokenType();
      throw E.tokenExpired();
    }
    throw E.tokenInvalid();
  }
}

const clientAuth = catchAsync(async (req, _res, next) => {
  const claims = readToken(req);
  if (claims.typ !== TYPE || !claims.client_id || !claims.company_id || !claims.group_id) throw E.invalidTokenType();
  const tenant = { groupId: claims.group_id, companyId: claims.company_id };
  const row = await inTenantTx(tenant, (transaction) => repository.statusOf(tenant.companyId, claims.client_id, transaction));
  if (!row) throw E.invalidClient();
  if (row.status !== 'ACTIVE') throw E.clientDisabled();
  req.apiClient = { clientId: claims.client_id, ...tenant, scopes: scopesOf(claims.scope) };
  return next();
});

/** Exige um scope do catálogo na rota. Marca `requiredScope` no middleware para a varredura (external.sweep.js) e para a documentação. */
function requireScope(scope) {
  const middleware = function requireScopeMiddleware(req, _res, next) {
    if (!req.apiClient) return next(E.invalidClient());
    return next(req.apiClient.scopes.includes(scope) ? undefined : E.insufficientScope(scope));
  };
  middleware.requiredScope = scope;
  return middleware;
}

module.exports = { clientAuth, requireScope };
