'use strict';

const AppError = require('../../../utils/AppError');

/** Erros da recomendação da NAY (M9-D007). Código estável, mensagem em português, sem detalhe técnico. */
const invalid = (message, details) => new AppError(message, 400, 'AI_RECOMMENDATION_INVALID', details);
const notFound = () => new AppError('Recomendação não encontrada.', 404, 'AI_RECOMMENDATION_NOT_FOUND');
const state = (message = 'Esta recomendação já foi decidida.') => new AppError(message, 409, 'AI_RECOMMENDATION_STATE');
const stale = () => new AppError('A situação mudou desde a proposta. Gere uma nova recomendação.', 409, 'AI_PROPOSAL_STALE');
const humanOnly = () => new AppError('Só uma pessoa pode decidir uma recomendação da NAY.', 403, 'AI_RECOMMENDATION_HUMAN_ONLY');
const sameRequester = () => new AppError('Quem solicitou não pode aprovar a própria proposta.', 403, 'AI_APPROVAL_SELF_BLOCKED');
const denied = (required) => AppError.forbidden('Você não tem permissão para esta ação. Peça o acesso a quem administra o seu perfil.', 'PERMISSION_DENIED', { required });

/** Traduz a recusa do gatilho do banco (AI021) e a unicidade da pendente; devolve null se o erro não for dele. */
function fromDbError(err) {
  const parent = err && (err.parent || err.original || err);
  if (parent && parent.code === 'AI021') return state();
  return null;
}

module.exports = { invalid, notFound, state, stale, humanOnly, sameRequester, denied, fromDbError };
