'use strict';

const jwt = require('jsonwebtoken');
const AppError = require('../../../../utils/AppError');

/**
 * Token de cliente (M9-D844 §3.2): JWT assinado com o mesmo segredo de acesso, `typ = 'client'`, sem usuário (`sub` ausente). O tipo separa as duas famílias: o middleware interno recusa
 * `typ = 'client'` e o middleware externo recusa tudo que não for. Claims: client_id, group_id, company_id e scope (scopes separados por espaço, RFC 6749).
 */
const TYPE = 'client';

function secret() {
  if (!process.env.JWT_ACCESS_SECRET) throw AppError.internal('Variável de ambiente obrigatória ausente: JWT_ACCESS_SECRET.', 'INTERNAL_ERROR');
  return process.env.JWT_ACCESS_SECRET;
}

function signClientToken({ clientId, groupId, companyId, scopes }, ttlSeconds) {
  return jwt.sign({ typ: TYPE, client_id: clientId, group_id: groupId, company_id: companyId, scope: scopes.join(' ') }, secret(), { expiresIn: ttlSeconds });
}

/** Confere assinatura e prazo. Lança o erro do `jsonwebtoken` (`name === 'TokenExpiredError'` para vencido); quem chama traduz. */
const verifyAnyToken = (token) => jwt.verify(token, secret());

const bearerOf = (req) => {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

/** Claims de um token de cliente VÁLIDO da requisição, ou null (nunca lança): serve ao limite de requisições e ao rastro de uso. */
function peekClientClaims(req) {
  const token = bearerOf(req);
  if (!token) return null;
  try {
    const claims = verifyAnyToken(token);
    return claims.typ === TYPE && claims.client_id ? claims : null;
  } catch (_err) {
    return null;
  }
}

const scopesOf = (text) => (typeof text === 'string' ? text.split(/\s+/).filter(Boolean) : []);

module.exports = { TYPE, signClientToken, verifyAnyToken, peekClientClaims, bearerOf, scopesOf };
