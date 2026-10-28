'use strict';

const AppError = require('../../utils/AppError');

/**
 * Erros do módulo Marketing (M9-D402). Todo código NOVO leva o prefixo MKT_ e mensagem em português; nunca stack nem detalhe do
 * provedor. Os códigos da plataforma reaproveitados sem renomear (lista fechada abaixo) são os da autenticação e do MFA.
 */
const MKT_PREFIX = 'MKT_';
const PLATFORM_CODES = Object.freeze([
  'MFA_STEP_UP_REQUIRED', 'MFA_REQUIRED_NOT_ENABLED', 'PERMISSION_DENIED', 'MISSING_ACCESS_TOKEN', 'INTERNAL_ERROR', 'VALIDATION_ERROR',
]);

function isAllowedCode(code) {
  return typeof code === 'string' && (code.startsWith(MKT_PREFIX) || PLATFORM_CODES.includes(code));
}

/** Cria um AppError do Marketing; recusa código sem prefixo MKT_ que não esteja na lista fechada. */
function mktError(statusCode, code, message, details) {
  if (!isAllowedCode(code)) {
    throw new Error(`Código de erro "${code}" fora do padrão: todo código novo do Marketing leva o prefixo ${MKT_PREFIX}.`);
  }
  return new AppError(message, statusCode, code, details);
}

function mktForbidden(details) {
  return mktError(403, 'MKT_FORBIDDEN', 'Você não tem permissão para esta ação de Marketing.', details);
}

function mktMassPermissionRequired(details) {
  return mktError(403, 'MKT_MASS_PERMISSION_REQUIRED', 'Disparo em massa exige a permissão de envio em massa.', details);
}

function mktMassLimitExceeded(details) {
  return mktError(422, 'MKT_MASS_LIMIT_EXCEEDED', 'O número de destinatários excede o limite permitido.', details);
}

function mktNotImplemented(owner) {
  return mktError(501, 'MKT_ROUTE_NOT_IMPLEMENTED', 'Esta operação de Marketing ainda não está disponível.', { owner });
}

module.exports = {
  MKT_PREFIX, PLATFORM_CODES, isAllowedCode, mktError, mktForbidden, mktMassPermissionRequired, mktMassLimitExceeded, mktNotImplemented,
};
