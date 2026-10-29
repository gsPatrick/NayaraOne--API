'use strict';

// M9-D701 — erros de negócio da exportação do BI (códigos e mensagens do livro).
const AppError = require('../../../utils/AppError');

const invalidBody = (message) => AppError.badRequest(message, 'ANALYTICS_EXPORT_INVALID');
const scopeNotFound = () => AppError.notFound('Empresa não encontrada ou sem acesso.', 'ANALYTICS_SCOPE_NOT_FOUND');
const notFound = () => AppError.notFound('Exportação não encontrada.', 'ANALYTICS_EXPORT_NOT_FOUND');
const expired = () => new AppError('O arquivo de exportação expirou.', 410, 'ANALYTICS_EXPORT_EXPIRED');
const mfaRequired = () => AppError.forbidden('Confirmação por MFA necessária para esta exportação.', 'MFA_STEP_UP_REQUIRED');
const notReady = (status) => AppError.conflict('A exportação ainda não está pronta para download.', 'ANALYTICS_EXPORT_NOT_READY', { status });
const tooLarge = (rows, max) => AppError.unprocessable(`A exportação tem ${rows} linhas e passa do limite de ${max}. Refine o recorte.`, 'ANALYTICS_EXPORT_TOO_LARGE', { rows, max });
const invalidLink = () => AppError.forbidden('O endereço de download é inválido ou venceu. Peça um novo.', 'ANALYTICS_EXPORT_LINK_INVALID');

/** Código gravado em error_code quando a permissão do solicitante some antes da geração (resposta HTTP 200 do job FAILED, mensagem do livro). */
const REVOKED_CODE = 'ANALYTICS_EXPORT_PERMISSION_REVOKED';
const REVOKED_MESSAGE = 'Job FAILED: você não tem mais permissão para este dado.';

module.exports = { invalidBody, scopeNotFound, notFound, expired, mfaRequired, notReady, tooLarge, invalidLink, REVOKED_CODE, REVOKED_MESSAGE };
