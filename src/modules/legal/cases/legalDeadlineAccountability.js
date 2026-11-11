'use strict';

const { LegalDeadline } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { normalizeOptionalText } = require('../shared/legalText');

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
 * Caderno M5 §15 "due_at em timezone correto + responsável + severidade": TODO prazo tem responsável — o próprio ou,
 * sem ele, o do processo (é para quem vai o alerta e a tarefa). Sem nenhum dos dois: 400.
 */
function assertHasResponsible(deadlineLike, legalCase) {
  if (!deadlineLike.responsibleUserId && !(legalCase && legalCase.responsibleUserId)) {
    throw AppError.badRequest(
      'Todo prazo precisa de um responsável: informe o responsável do prazo ou defina o responsável do processo.',
      'LEGAL_DEADLINE_RESPONSIBLE_REQUIRED'
    );
  }
}

/**
 * Caminho vizinho: o processo nao pode perder responsavel/escalonamento enquanto houver prazo
 * CRITICAL pendente que dependa deles, nem perder o responsavel enquanto houver prazo pendente
 * (de qualquer criticidade) sem responsavel proprio, que ficaria sem ninguem (422).
 */
async function assertCaseKeepsCriticalAccountability(legalCase, transaction) {
  const pending = await LegalDeadline.findAll({ where: { legalCaseId: legalCase.id, status: 'PENDING' }, transaction });
  for (const deadline of pending) {
    if (deadline.criticality === 'CRITICAL') assertCriticalDeadlineAccountability(deadline, legalCase);
    else if (!deadline.responsibleUserId && !legalCase.responsibleUserId) {
      throw AppError.unprocessable(
        `O processo não pode ficar sem responsável: o prazo "${deadline.description}" está pendente e depende dele.`,
        'LEGAL_DEADLINE_RESPONSIBLE_REQUIRED'
      );
    }
  }
}

/** Normaliza a nota: tira espacos e caracteres invisiveis; vazio vira null; nao-texto e recusado (400). */
function normalizeNote(value) {
  return normalizeOptionalText(value, 'conclusionNote');
}

module.exports = { assertCriticalDeadlineAccountability, assertCaseKeepsCriticalAccountability, assertHasResponsible, normalizeNote };
