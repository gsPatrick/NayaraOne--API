'use strict';

const AppError = require('../../../utils/AppError');

/** Erros da aprovação humana de ações da NAY (M9-D019). Código estável, mensagem em português, sem detalhe técnico. */
const permissionDenied = (required) => AppError.forbidden('Você não tem permissão para esta ação.', 'AI_PERMISSION_DENIED', { required });
const integrity = () => new AppError('Os dados da proposta não conferem com o que foi proposto. Gere uma nova proposta.', 409, 'AI_PROPOSAL_INTEGRITY');
/** Recusas da criação da proposta: `proposalRefused` faz o executor gravar a chamada como BLOCKED com o motivo. */
const paymentProposalOff = () => new AppError(
  'A NAY não propõe pagamentos nesta empresa. Use a rota de pagamentos do Financeiro, que exige a sua aprovação.', 403, 'AI_PAYMENT_PROPOSAL_DISABLED', { proposalRefused: true, reason: 'proposta_de_pagamento_desligada' }
);
const runAwaiting = () => new AppError(
  'Esta execução da NAY já aguarda a aprovação de uma proposta. Decida a proposta antes de pedir outra ação.', 409, 'AI_RUN_AWAITING_APPROVAL', { proposalRefused: true, reason: 'execucao_aguardando_aprovacao' }
);
const runUnavailable = () => new AppError('A execução da NAY não está aberta para novas propostas.', 409, 'AI_RUN_NOT_OPEN', { proposalRefused: true, reason: 'execucao_nao_aberta' });

module.exports = { permissionDenied, integrity, paymentProposalOff, runAwaiting, runUnavailable };
