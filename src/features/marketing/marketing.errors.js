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

/** Segurança e antifraude (M9-D433). */
function mktUrlNotAllowed(details) {
  return mktError(422, 'MKT_URL_NOT_ALLOWED', 'URL externa não permitida.', details);
}

function mktExportForbidden(details) {
  return mktError(403, 'MKT_EXPORT_FORBIDDEN', 'Exportar lista de destinatários não é permitido.', details);
}

function mktChannelCompromised(details) {
  return mktError(423, 'MKT_CHANNEL_COMPROMISED', 'O canal está bloqueado por suspeita de comprometimento.', details);
}

function mktSourceStale(details) {
  return mktError(409, 'MKT_SOURCE_STALE', 'Os dados do imóvel mudaram; gere o conteúdo novamente.', details);
}

function mktContentVersionImmutable(details) {
  return mktError(409, 'MKT_CONTENT_VERSION_IMMUTABLE', 'A versão publicada não pode ser alterada.', details);
}

function mktNayRunRequired(details) {
  return mktError(422, 'MKT_NAY_RUN_REQUIRED', 'Conteúdo gerado pela NAY deve registrar a execução.', details);
}

function mktNayModelRequired(details) {
  return mktError(422, 'MKT_NAY_MODEL_REQUIRED', 'A execução da NAY informada exige o nome do modelo usado.', details);
}

function mktNotImplemented(owner) {
  return mktError(501, 'MKT_ROUTE_NOT_IMPLEMENTED', 'Esta operação de Marketing ainda não está disponível.', { owner });
}

module.exports = {
  MKT_PREFIX, PLATFORM_CODES, isAllowedCode, mktError, mktForbidden, mktMassPermissionRequired, mktMassLimitExceeded, mktNotImplemented,
  mktUrlNotAllowed, mktExportForbidden, mktChannelCompromised, mktSourceStale, mktContentVersionImmutable, mktNayRunRequired, mktNayModelRequired,
};
