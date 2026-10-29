'use strict';

const AppError = require('../../../utils/AppError');

/** Erros da identidade de serviço (M9-D017). Código estável e mensagem em português. */
const READ_ONLY_MESSAGE = 'A identidade de serviço só pode ter permissões de leitura.';
const invalid = (message = READ_ONLY_MESSAGE, details) => new AppError(message, 400, 'AI_SERVICE_IDENTITY_INVALID', details);
const notFound = () => AppError.notFound('Identidade de serviço não encontrada.', 'AI_SERVICE_IDENTITY_NOT_FOUND');
const exists = () => AppError.conflict('Já existe uma identidade de serviço para este agente nesta empresa.', 'AI_SERVICE_IDENTITY_EXISTS');
const denied = () => AppError.forbidden('Você não tem permissão para administrar identidades de serviço da NAY.', 'PERMISSION_DENIED', { required: 'ai:admin' });

/** Traduz a recusa do banco (CHECK de leitura e unicidade) para o erro estável da API; devolve null se não for dele. */
function fromDbError(err) {
  const parent = err && (err.parent || err.original || err);
  const texto = `${(parent && parent.constraint) || ''} ${(parent && parent.message) || ''}`;
  if (parent && parent.code === '23505' && /service_identities_company_agent_uq/.test(texto)) return exists();
  if (parent && parent.code === '23514' && /service_identities_read_only_chk/.test(texto)) return invalid();
  return null;
}

module.exports = { READ_ONLY_MESSAGE, invalid, notFound, exists, denied, fromDbError };
