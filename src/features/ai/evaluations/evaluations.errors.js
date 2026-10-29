'use strict';

const AppError = require('../../../utils/AppError');

/** Erros da avaliação da NAY (M9-D031/D032). Código estável, mensagem em português, sem detalhe técnico. */
const invalid = (message, details) => new AppError(message, 400, 'AI_EVALUATION_INVALID', details);
const notFound = () => new AppError('Avaliação não encontrada.', 404, 'AI_EVALUATION_NOT_FOUND');
const notPassed = () => new AppError('A avaliação não passou e não pode ser homologada.', 409, 'AI_EVALUATION_NOT_PASSED');
const selfBlocked = () => new AppError('Quem disparou a avaliação não pode homologá-la.', 403, 'AI_HOMOLOGATION_SELF_BLOCKED');
const state = (message = 'Esta avaliação já foi homologada por outra pessoa.') => new AppError(message, 409, 'AI_EVALUATION_STATE');
const immutable = () => new AppError('Avaliação finalizada não pode ser alterada.', 409, 'AI_EVALUATION_IMMUTABLE');
const realProviderDisabled = () => new AppError('Avaliações usam o provedor de testes nesta empresa.', 409, 'AI_REAL_PROVIDER_EVAL_DISABLED');
const providerNotFound = () => new AppError('Provedor não encontrado.', 404, 'AI_PROVIDER_NOT_FOUND');
const humanOnly = () => new AppError('Só uma pessoa pode homologar uma avaliação.', 403, 'AI_EVALUATION_HUMAN_ONLY');
const noteRequired = () => new AppError('Informe a nota da homologação (agente de alto impacto).', 400, 'AI_HOMOLOGATION_NOTE_REQUIRED');
const feedbackInvalid = (message) => new AppError(message, 400, 'AI_FEEDBACK_INVALID');
const candidateNotFound = () => new AppError('Candidato não encontrado.', 404, 'AI_GOLDEN_CANDIDATE_NOT_FOUND');
const candidateState = () => new AppError('Este candidato já foi decidido.', 409, 'AI_GOLDEN_CANDIDATE_STATE');
const runNotFound = () => new AppError('Execução não encontrada.', 404, 'AI_RUN_NOT_FOUND');

/** Traduz a recusa dos gatilhos do banco (AI041, AI042, AI043); devolve null se o erro não for dele. */
function fromDbError(err) {
  const parent = err && (err.parent || err.original || err);
  const code = parent && parent.code;
  if (code === 'AI041' || code === 'AI042') return immutable();
  if (code === 'AI043') return candidateState();
  return null;
}

module.exports = {
  invalid, notFound, notPassed, selfBlocked, state, immutable, realProviderDisabled, providerNotFound, humanOnly, noteRequired,
  feedbackInvalid, candidateNotFound, candidateState, runNotFound, fromDbError,
};
