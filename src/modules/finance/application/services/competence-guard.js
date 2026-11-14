'use strict';

/**
 * Guardas de competência usadas pelos serviços de lançamento e recebimento (Caderno §16; M4-19 e C1).
 */
const AppError = require('../../../../utils/AppError');
const periodClosuresService = require('./closing.service');
const { isCompetenceInformed, isValidCompetenceMonth, deriveCompetenceMonth } = require('../../domain/financial-entry');

// C1 (coordenação com a frente "fechamento"): a guarda de COMPETÊNCIA (assertCompetenceOpen —
// bloqueia CLOSED e REVIEW, nos dois sentidos: entrar e sair do mês) é da frente de fechamento
// (closing.service.js). Enquanto ela não estiver disponível, cai na guarda antiga por
// mês (assertPeriodOpenForEntry, que aceita "YYYY-MM" e bloqueia só CLOSED) — a chamada daqui
// já é a definitiva e não precisa mudar quando a guarda nova chegar.
function assertCompetenceOpen(companyId, competenceMonths, transaction) {
  if (typeof periodClosuresService.assertCompetenceOpen === 'function') {
    return periodClosuresService.assertCompetenceOpen(companyId, competenceMonths, transaction);
  }
  return periodClosuresService.assertPeriodOpenForEntry(companyId, [].concat(competenceMonths), transaction);
}

/** M4-19: período fechado bloqueia lançamento naquele mês (guarda por mês, bloqueia CLOSED). */
function assertPeriodOpenForEntry(companyId, dates, transaction) {
  return periodClosuresService.assertPeriodOpenForEntry(companyId, dates, transaction);
}

function isPeriodClosed(companyId, competenceMonth, transaction) {
  return periodClosuresService.isPeriodClosed(companyId, competenceMonth, transaction);
}

/** M4-03: competência informada (validada) ou derivada do vencimento/criação. */
function resolveCompetenceMonth(competenceMonth, dueAt) {
  if (isCompetenceInformed(competenceMonth)) {
    const normalized = String(competenceMonth).trim();
    if (!isValidCompetenceMonth(normalized)) {
      throw AppError.badRequest(
        'A competência precisa estar no formato mês/ano (ex.: 09/2026).',
        'FINANCE_ENTRY_VALIDATION'
      );
    }
    return normalized;
  }
  return deriveCompetenceMonth(dueAt);
}

module.exports = { assertCompetenceOpen, assertPeriodOpenForEntry, isPeriodClosed, resolveCompetenceMonth };
