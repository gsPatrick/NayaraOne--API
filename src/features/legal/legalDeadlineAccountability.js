'use strict';

const { LegalDeadline } = require('../../models');
const AppError = require('../../utils/AppError');
const { normalizeOptionalText } = require('./legalText');

/**
 * Regra do alerta (engines/jobs/legalDeadlineAlertJob.js): quem recebe o aviso e
 * `deadline.responsibleUserId || legalCase.responsibleUserId`, e o escalonamento depois de 24h
 * vencido so acontece se o PROCESSO tiver `escalationUserId`. Prazo CRITICAL sem um dos dois
 * ficaria sem ninguem avisado/escalado, entao a exigencia vale desde a criacao.
 */
function assertCriticalDeadlineAccountability(deadlineLike, legalCase) {
  const responsible = deadlineLike.responsibleUserId || legalCase.responsibleUserId;
  if (!responsible) {
    throw AppError.unprocessable(
      'Prazo crítico exige um responsável efetivo: informe o responsável do prazo ou defina o responsável do processo.',
      'LEGAL_DEADLINE_CRITICAL_RESPONSIBLE_REQUIRED'
    );
  }
  if (!legalCase.escalationUserId) {
    throw AppError.unprocessable(
      'Prazo crítico exige um destino de escalonamento: defina o usuário de escalonamento no processo.',
      'LEGAL_DEADLINE_CRITICAL_ESCALATION_REQUIRED'
    );
  }
}

/**
 * Caminho vizinho: o processo nao pode perder responsavel/escalonamento enquanto houver prazo
 * CRITICAL pendente que dependa deles.
 */
async function assertCaseKeepsCriticalAccountability(legalCase, transaction) {
  const pending = await LegalDeadline.findAll({
    where: { legalCaseId: legalCase.id, status: 'PENDING', criticality: 'CRITICAL' },
    transaction,
  });
  for (const deadline of pending) assertCriticalDeadlineAccountability(deadline, legalCase);
}

/** Normaliza a nota: tira espacos e caracteres invisiveis; vazio vira null; nao-texto e recusado (400). */
function normalizeNote(value) {
  return normalizeOptionalText(value, 'conclusionNote');
}

module.exports = { assertCriticalDeadlineAccountability, assertCaseKeepsCriticalAccountability, normalizeNote };
