'use strict';

const AppError = require('../../utils/AppError');

const { TERMINAL_STAGES, canonicalStage } = require('./opportunityStages');

// Estágios terminais do livro §10 (WON e LOST): não exigem próxima ação. Códigos antigos (CLOSED_WON, CLOSED_LOST, WITHDRAWN)
// são lidos pelo equivalente do livro (opportunityStages.js).
const CLOSED_STAGES = TERMINAL_STAGES;

function isActiveStage(stage) {
  return !CLOSED_STAGES.includes(canonicalStage(stage));
}

/**
 * assertNextActionWhenActive — regra dura de negócio (Marco 3): toda opportunity em estágio
 * ATIVO (qualquer stage fora de WON/LOST) precisa ter `nextAction` e
 * `nextActionDueAt` preenchidos. Validado na aplicação (não via CHECK constraint) porque a
 * definição de "estágio ativo" depende do valor livre de `stage` (funil configurável por
 * tenant no futuro) — ver decisão documentada em src/documentacao/features/Crm.md.
 * Lança 422 se violada.
 */
function assertNextActionWhenActive({ stage, nextAction, nextActionDueAt }) {
  if (!isActiveStage(stage)) return;
  if (!nextAction || !nextActionDueAt) {
    throw AppError.unprocessable(
      'Oportunidades em estágio ativo exigem "nextAction" e "nextActionDueAt" preenchidos.',
      'OPPORTUNITY_NEXT_ACTION_REQUIRED',
      { stage }
    );
  }
}

module.exports = { CLOSED_STAGES, isActiveStage, assertNextActionWhenActive };
