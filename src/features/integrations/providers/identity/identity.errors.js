'use strict';

const AppError = require('../../../../utils/AppError');

/** 401 INTEGRATION_IDENTITY_TOKEN_INVALID: o motivo técnico (`reason`) fica só em details, nunca no texto da pessoa. */
const tokenInvalid = (reason) => AppError.unauthorized('Credencial inválida ou expirada.', 'INTEGRATION_IDENTITY_TOKEN_INVALID', reason ? { reason } : undefined);

/** 403 INTEGRATION_IDENTITY_FALLBACK_DENIED: o provedor de identidade está fora e a política não libera o login local para este usuário. */
const fallbackDenied = () => AppError.forbidden('O login único da empresa está indisponível e o acesso local não está liberado para o seu perfil. Fale com o administrador.', 'INTEGRATION_IDENTITY_FALLBACK_DENIED');

module.exports = { tokenInvalid, fallbackDenied };
