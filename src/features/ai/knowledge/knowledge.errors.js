'use strict';

const AppError = require('../../../utils/AppError');

/** Erros do conhecimento homologado (M9-D008). Código estável, mensagem em português, sem detalhe técnico. */
const invalid = (message, details) => new AppError(message, 400, 'AI_KNOWLEDGE_INVALID', details);
const notFound = () => new AppError('Conhecimento não encontrado.', 404, 'AI_KNOWLEDGE_NOT_FOUND');
const selfHomologation = () => new AppError('Quem escreveu não pode homologar.', 403, 'AI_KNOWLEDGE_SELF_HOMOLOGATION');
const immutable = () => new AppError('Conhecimento homologado não pode ser editado; crie uma nova versão.', 409, 'AI_KNOWLEDGE_IMMUTABLE');
const secretDetected = () => new AppError('O conteúdo parece conter uma credencial e não pode ser salvo.', 400, 'AI_KNOWLEDGE_SECRET_DETECTED');
const badTransition = (from, to) => new AppError(`O conhecimento não pode passar de ${from} para ${to}.`, 409, 'AI_KNOWLEDGE_TRANSITION', { from, to });
const staleVersion = (current) => new AppError('Já existe uma versão mais nova homologada deste conhecimento.', 409, 'AI_KNOWLEDGE_STALE_VERSION', { homologatedVersion: current });
const versionConflict = () => new AppError('Outra pessoa alterou este conhecimento ao mesmo tempo; tente de novo.', 409, 'AI_KNOWLEDGE_VERSION_CONFLICT');

/** Traduz a recusa do banco (gatilhos AI021-AI024 e unicidade) para o erro estável da API; devolve null se não for dele. */
function fromDbError(err) {
  const parent = err && (err.parent || err.original || err);
  const code = parent && parent.code;
  const message = String((parent && parent.message) || '');
  if (code === 'AI021') return immutable();
  if (code === 'AI022') {
    const m = /de (\w+) para (\w+)/.exec(message);
    return badTransition(m ? m[1] : '?', m ? m[2] : '?');
  }
  if (code === 'AI023') return selfHomologation();
  if (code === 'AI024') return invalid('A homologação precisa de pessoa e data.');
  if (code === '23505' && /ai_knowledge_(fact_version|one_homologated)_uq/.test(`${parent.constraint || ''} ${message}`)) return versionConflict();
  return null;
}

module.exports = { invalid, notFound, selfHomologation, immutable, secretDetected, badTransition, staleVersion, versionConflict, fromDbError };
