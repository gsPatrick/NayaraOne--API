'use strict';

// Barrel fino: reexporta o CRUD de Opportunity e seus colaboradores especializados
// (validação de next_action / publicação de domain events), mantendo um único ponto de
// entrada estável para quem já dependia de `opportunities.service.js` (ex.: testes de
// integração). Novo código deve preferir importar diretamente opportunity.service.js /
// opportunityNextAction.validator.js / opportunityEvents.service.js conforme necessário.

const opportunityService = require('./opportunity.service');
const { isActiveStage, assertNextActionWhenActive, CLOSED_STAGES } = require('./opportunityNextAction.validator');
const outcomeReasons = require('./opportunityOutcomeReason.validator');

module.exports = {
  ...opportunityService,
  isActiveStage,
  assertNextActionWhenActive,
  CLOSED_STAGES,
  // M3-12 — enums fechados de motivo de ganho/perda/desistência.
  WON_REASONS: outcomeReasons.WON_REASONS,
  LOST_REASONS: outcomeReasons.LOST_REASONS,
  WITHDRAWN_REASONS: outcomeReasons.WITHDRAWN_REASONS,
  OUTCOME_STAGES: outcomeReasons.OUTCOME_STAGES,
  assertOutcomeReason: outcomeReasons.assertOutcomeReason,
};
