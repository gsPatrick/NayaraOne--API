'use strict';

const AppError = require('../../../utils/AppError');

/** Erros das chamadas de ferramenta (M9-D006). Código estável, mensagem em português, sem os argumentos nem o resultado. */
const invalid = (message, details) => new AppError(message, 400, 'AI_TOOL_CALL_INVALID', details);
const notFound = () => new AppError('Chamada de ferramenta não encontrada.', 404, 'AI_TOOL_CALL_NOT_FOUND');
const inProgress = () => new AppError('Esta chamada ainda está em andamento.', 409, 'AI_TOOL_CALL_IN_PROGRESS');
const notAllowed = () => new AppError('Você não tem permissão para esta ferramenta.', 403, 'AI_TOOL_NOT_ALLOWED');
const immutable = () => new AppError('Chamada de ferramenta finalizada não pode ser alterada.', 409, 'AI_TOOL_CALL_IMMUTABLE');
const badTransition = (from, to) => new AppError(`A chamada não pode passar de ${from} para ${to}.`, 409, 'AI_TOOL_CALL_TRANSITION', { from, to });
const alreadyBlocked = (reason) => new AppError('Esta chamada já foi bloqueada e não será executada de novo.', 409, 'AI_TOOL_CALL_BLOCKED', { blockedReason: reason || null, replayed: true });
const seqConflict = () => new AppError('Já existe outra chamada com este número de ordem no run.', 409, 'AI_TOOL_CALL_SEQ_CONFLICT');
const denied = () => AppError.forbidden('Você não tem permissão para ver as chamadas de ferramenta da NAY.', 'PERMISSION_DENIED', { required: 'ai:audit' });
const notClaimed = () => AppError.internal('A chamada de ferramenta não foi registrada antes do resultado.', 'AI_TOOL_CALL_NOT_CLAIMED');

/** Traduz a recusa do banco (gatilhos AI031/AI032 e unicidade da ordem); devolve null se não for dele. */
function fromDbError(err) {
  const parent = err && (err.parent || err.original || err);
  const code = parent && parent.code;
  const message = String((parent && parent.message) || '');
  if (code === 'AI031') return immutable();
  if (code === 'AI032') {
    const m = /de (\w+) para (\w+)/.exec(message);
    return badTransition(m ? m[1] : '?', m ? m[2] : '?');
  }
  if (code === '23505' && /tool_calls_run_seq_uq/.test(`${parent.constraint || ''} ${message}`)) return seqConflict();
  return null;
}

module.exports = { invalid, notFound, inProgress, notAllowed, immutable, badTransition, alreadyBlocked, seqConflict, denied, notClaimed, fromDbError };
