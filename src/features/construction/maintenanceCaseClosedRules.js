'use strict';

const AppError = require('../../utils/AppError');

const hasEvidence = (ids) => Array.isArray(ids) && ids.some((id) => typeof id === 'string' && id.trim() !== '');

/**
 * Auditoria da cliente (Marco 6): os requisitos de fechamento (causa raiz, evidencias antes e
 * depois, ao menos uma acao de atendimento) valem tambem em QUALQUER atualizacao de um chamado
 * que continua FECHADO. Alterar esses campos de forma que deixe de cumpri-los e recusado; o
 * chamado fechado so pode trocar um valor valido por outro. (Nao existe reabertura formal no
 * modulo: CLOSED e terminal.)
 *
 * `final` e o estado que o chamado teria depois da atualizacao.
 */
function assertClosedCaseStillMeetsRequirements(final) {
  const missing = [];
  if (!final.rootCauseCode) missing.push('causa raiz');
  if (!hasEvidence(final.beforeMediaFileIds)) missing.push('evidência "antes"');
  if (!hasEvidence(final.afterMediaFileIds)) missing.push('evidência "depois"');
  if (!(final.actionCount > 0)) missing.push('ação de atendimento');
  if (missing.length) {
    throw AppError.unprocessable(
      `Chamado fechado precisa manter ${missing.join(', ')}. Você pode trocar por outro valor válido, mas não retirar.`,
      'MAINTENANCE_CASE_CLOSED_REQUIREMENTS',
      { missing }
    );
  }
}

/** Causa raiz recebida no payload: vazio/em branco significa retirar (null). */
function isBlankRootCause(value) {
  return value === null || (typeof value === 'string' && value.trim() === '');
}

module.exports = { assertClosedCaseStillMeetsRequirements, isBlankRootCause, hasEvidence };
