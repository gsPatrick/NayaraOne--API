'use strict';

const { govError } = require('../../governance.errors');

/** Erros da API externa (M9-D844 §4). Os quatro primeiros e o de expiração têm código, status e texto fixados pelo livro. */
const invalidClient = () => govError(401, 'GOV_INVALID_CLIENT', 'Credenciais inválidas.');
const insufficientScope = (required) => govError(403, 'GOV_INSUFFICIENT_SCOPE', 'A credencial não tem permissão para esta operação.', { required });
const clientDisabled = () => govError(401, 'GOV_CLIENT_DISABLED', 'Esta credencial está desativada.');
const invalidTokenType = () => govError(401, 'GOV_AUTH_INVALID_TOKEN_TYPE', 'Tipo de credencial não aceito aqui.');
const tokenExpired = () => govError(401, 'GOV_TOKEN_EXPIRED', 'O token expirou. Obtenha um novo token.');
const tokenInvalid = () => govError(401, 'GOV_TOKEN_INVALID', 'Token de acesso inválido.');
const unsupportedGrant = () => govError(400, 'GOV_UNSUPPORTED_GRANT_TYPE', 'Informe grant_type=client_credentials.');
const invalidScope = (details) => govError(400, 'GOV_INVALID_SCOPE', 'Nenhum dos scopes pedidos é permitido para esta credencial.', details);
const clientInvalid = (details) => govError(422, 'GOV_API_CLIENT_INVALID', 'Dados da credencial inválidos.', details);
const clientNotFound = () => govError(404, 'GOV_API_CLIENT_NOT_FOUND', 'Credencial não encontrada.');
const clientAlreadyRevoked = () => govError(409, 'GOV_API_CLIENT_REVOKED', 'Esta credencial já foi revogada.');
const leadInvalid = (details) => govError(422, 'GOV_EXTERNAL_LEAD_INVALID', 'Dados do lead inválidos.', details);
const leadDuplicate = () => govError(409, 'GOV_EXTERNAL_LEAD_DUPLICATE', 'Já existe um cadastro com este documento ou contato.');
const routeWithoutScope = (routes) => govError(500, 'GOV_EXTERNAL_ROUTE_WITHOUT_SCOPE', 'Rota externa sem scope declarado.', { routes });

module.exports = {
  invalidClient, insufficientScope, clientDisabled, invalidTokenType, tokenExpired, tokenInvalid, unsupportedGrant, invalidScope, clientInvalid, clientNotFound, clientAlreadyRevoked, leadInvalid, leadDuplicate, routeWithoutScope,
};
