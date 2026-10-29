'use strict';

const AppError = require('../../../utils/AppError');

/** Erros da memória da NAY (M9-D009). Código estável, mensagem em português, sem detalhe técnico. */
const freeText = () => new AppError('Memória só aceita fatos estruturados, não a conversa inteira.', 422, 'AI_MEMORY_FREE_TEXT_BLOCKED');
const typeInvalid = (permitidos) => new AppError('Tipo de memória não permitido.', 400, 'AI_MEMORY_TYPE_INVALID', { permitidos });
const sourceRequired = () => new AppError('Informe a origem da memória.', 400, 'AI_MEMORY_SOURCE_REQUIRED');
const sourceNotFound = () => new AppError('A origem informada não foi encontrada nesta empresa.', 400, 'AI_MEMORY_SOURCE_INVALID');
const deleteForbidden = () => new AppError('Memória não é apagada; invalide-a.', 409, 'AI_MEMORY_DELETE_FORBIDDEN');
const invalid = (message, details) => new AppError(message, 400, 'AI_MEMORY_INVALID', details);
const valueInvalid = (message, details) => new AppError(message, 400, 'AI_MEMORY_VALUE_INVALID', details);
const expiresInvalid = (message) => new AppError(message, 400, 'AI_MEMORY_EXPIRES_INVALID');
const notFound = () => new AppError('Memória não encontrada.', 404, 'AI_MEMORY_NOT_FOUND');
const notActive = () => new AppError('Só memória vigente pode ser invalidada ou corrigida.', 409, 'AI_MEMORY_NOT_ACTIVE');
const humanRequired = () => new AppError('Este tipo de memória só é gravado por uma pessoa com permissão de administração da NAY.', 403, 'AI_MEMORY_HUMAN_REQUIRED');
const sourceNotDecided = () => new AppError('A NAY só grava esta memória a partir de uma recomendação com decisão humana registrada.', 403, 'AI_MEMORY_SOURCE_NOT_DECIDED');
const selfActivation = () => new AppError('Quem escreveu o procedimento não pode ativá-lo como memória.', 403, 'AI_MEMORY_SELF_ACTIVATION');
const sourceNotHomologated = () => new AppError('Procedimento aprovado exige origem em conhecimento homologado.', 422, 'AI_MEMORY_SOURCE_NOT_HOMOLOGATED');
const denied = (required) => AppError.forbidden('Você não tem permissão para esta ação. Peça o acesso a quem administra o seu perfil.', 'PERMISSION_DENIED', { required });

/** Traduz a recusa do gatilho do banco (AI051, AI052) e a corrida de duas correções; devolve null se o erro não for dele. */
function fromDbError(err) {
  const parent = err && (err.parent || err.original || err);
  const code = parent && parent.code;
  if (code === 'AI052') return deleteForbidden();
  if (code === 'AI051') return notActive();
  if (code === '23505' && /ai_memories_supersedes_uq/.test(`${parent.constraint || ''} ${parent.message || ''}`)) return notActive();
  return null;
}

module.exports = {
  freeText, typeInvalid, sourceRequired, sourceNotFound, deleteForbidden, invalid, valueInvalid, expiresInvalid, notFound, notActive,
  humanRequired, sourceNotDecided, selfActivation, sourceNotHomologated, denied, fromDbError,
};
