'use strict';

const AppError = require('../../../utils/AppError');

/** Erros de segurança da chamada de tool (M9-D017). Código estável e mensagem em português; nenhuma revela se o dado existe em outra empresa. */
const permissionDenied = () => AppError.forbidden('Você não tem permissão para consultar estes dados.', 'AI_PERMISSION_DENIED');
const crossCompanyBlocked = () => AppError.notFound('Dado não encontrado.', 'AI_CROSS_COMPANY_BLOCKED');
const secretRequestBlocked = () => AppError.forbidden('A NAY não fornece credenciais ou segredos.', 'AI_SECRET_REQUEST_BLOCKED');
const connectionNotAllowed = () => new AppError('A conexão da NAY com o banco não é a de execução restrita.', 500, 'AI_CONNECTION_NOT_ALLOWED');
const contextInvalid = (message) => AppError.badRequest(message || 'Contexto de execução da NAY inválido.', 'AI_CONTEXT_INVALID');
const serviceIdentityDisabled = () => AppError.forbidden('Não há identidade de serviço ativa para este agente nesta empresa.', 'AI_SERVICE_IDENTITY_DISABLED');

module.exports = { permissionDenied, crossCompanyBlocked, secretRequestBlocked, connectionNotAllowed, contextInvalid, serviceIdentityDisabled };
