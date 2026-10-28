'use strict';

const AppError = require('../../../../utils/AppError');

/** Erros do registro de execução (M9-D005). Código estável, mensagem em português, sem detalhe técnico. */
const invalid = (message, details) => new AppError(message, 400, 'AI_RUN_INVALID', details);
const notFound = () => new AppError('Execução não encontrada.', 404, 'AI_RUN_NOT_FOUND');
const immutable = () => new AppError('Execução finalizada não pode ser alterada.', 409, 'AI_RUN_IMMUTABLE');
const badTransition = (from, to) => new AppError(`A execução não pode passar de ${from} para ${to}.`, 409, 'AI_RUN_TRANSITION', { from, to });
const idempotencyConflict = () => new AppError('Esta chave de idempotência já foi usada com outro pedido.', 409, 'AI_RUN_IDEMPOTENCY_CONFLICT');
const denied = () => AppError.forbidden('Você não tem permissão para ver execuções da NAY.', 'PERMISSION_DENIED', { required: 'ai:read|ai:audit' });

/** Traduz a recusa do banco (gatilhos AI011/AI012 e unicidade) para o erro estável da API; devolve null se não for dele. */
function fromDbError(err) {
  const parent = err && (err.parent || err.original || err);
  const code = parent && parent.code;
  const message = String((parent && parent.message) || '');
  if (code === 'AI011') return immutable();
  if (code === 'AI012') {
    const m = /de (\w+) para (\w+)/.exec(message);
    return badTransition(m ? m[1] : '?', m ? m[2] : '?');
  }
  if (code === '23505' && /ai_runs_idempotency_uq/.test(`${parent.constraint || ''} ${message}`)) return idempotencyConflict();
  return null;
}

module.exports = { invalid, notFound, immutable, badTransition, idempotencyConflict, denied, fromDbError };
