'use strict';

const { govError } = require('../governance.errors');

/**
 * Motivo do bloqueio -> erro HTTP (M9-D821 §4). A etapa 2 é a dona de GOV_DLP_DENIED (POLICY), GOV_DLP_USER_SUSPENDED (SUSPENDED) e GOV_DLP_PERMISSION (PERMISSION);
 * a 3 de GOV_DLP_PURPOSE_REQUIRED, a 4 de MFA_STEP_UP_REQUIRED e a 5 de GOV_DLP_VOLUME_EXCEEDED. Mensagens em português, as do livro/da demanda.
 */
const REASONS = Object.freeze({
  POLICY: { httpStatus: 403, errorCode: 'GOV_DLP_DENIED', message: 'Esta ação não é permitida para dados desta classificação.' },
  SUSPENDED: { httpStatus: 403, errorCode: 'GOV_DLP_USER_SUSPENDED', message: 'Seu acesso a exportações está suspenso temporariamente por uso fora do padrão.' },
  PERMISSION: { httpStatus: 403, errorCode: 'GOV_DLP_PERMISSION', message: 'Você não tem permissão para esta exportação.' },
  PURPOSE: { httpStatus: 422, errorCode: 'GOV_DLP_PURPOSE_REQUIRED', message: null },
  MFA: { httpStatus: 403, errorCode: 'MFA_STEP_UP_REQUIRED', message: 'Confirme o código de verificação para continuar.' },
  VOLUME: { httpStatus: 422, errorCode: 'GOV_DLP_VOLUME_EXCEEDED', message: 'O volume pedido excede o limite desta classificação.' },
});

/** "Informe a finalidade e uma justificativa com pelo menos N caracteres." — N é o parâmetro governanca.dlp.justificativa_min. */
const purposeMessage = (min) => `Informe a finalidade e uma justificativa com pelo menos ${min} caracteres.`;

/** AppError pronto para o chamador lançar quando a decisão for DENY. */
function blockedError(decision, justificationMin) {
  const reason = REASONS[decision.blockReason];
  const message = decision.blockReason === 'PURPOSE' ? purposeMessage(justificationMin) : reason.message;
  return govError(reason.httpStatus, reason.errorCode, message, { blockReason: decision.blockReason, exportJobId: decision.job ? decision.job.id : null });
}

module.exports = { REASONS, purposeMessage, blockedError };
