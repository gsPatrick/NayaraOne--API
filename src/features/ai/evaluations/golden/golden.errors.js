'use strict';

const AppError = require('../../../../utils/AppError');

/** Erros do golden dataset da NAY (M9-D033). Código estável, mensagem em português, sem detalhe técnico. */
const invalid = (message, details) => new AppError(message, 400, 'AI_GOLDEN_INVALID', details);
const pii = (details) => new AppError('O caso de teste não pode conter dado pessoal real: use dados sintéticos.', 400, 'AI_GOLDEN_PII', details);
const notFound = () => new AppError('Caso de teste não encontrado.', 404, 'AI_GOLDEN_CASE_NOT_FOUND');
const immutable = () => new AppError('O caso de teste não muda: crie a versão seguinte.', 409, 'AI_GOLDEN_IMMUTABLE');
const limit = () => new AppError('O agente atingiu o limite de casos de teste ativos.', 409, 'AI_GOLDEN_LIMIT');
const state = (message) => new AppError(message, 409, 'AI_GOLDEN_STATE');
const candidateNotApproved = () => new AppError('Só um candidato aprovado por uma pessoa entra no golden dataset.', 409, 'AI_GOLDEN_CANDIDATE_NOT_APPROVED');

/** Traduz a recusa do gatilho do banco (AI044) e a unicidade; devolve null se o erro não for dele. */
function fromDbError(err) {
  const parent = err && (err.parent || err.original || err);
  const code = parent && parent.code;
  if (code === 'AI044') return immutable();
  if (code === '23505' && /ai_golden_cases_candidate_uq/.test(`${parent.constraint || ''} ${parent.message || ''}`)) return state('Este candidato já virou caso do golden dataset.');
  if (code === '23505') return state('Já existe um caso ativo com esta chave; crie a versão seguinte.');
  return null;
}

module.exports = { invalid, pii, notFound, immutable, limit, state, candidateNotApproved, fromDbError };
