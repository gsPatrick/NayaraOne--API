'use strict';

// Barrel fino: reexporta o CRUD de Opportunity e seus colaboradores especializados
// (validação de next_action / publicação de domain events), mantendo um único ponto de
// entrada estável para quem já dependia de `opportunities.service.js` (ex.: testes de
// integração). Novo código deve preferir importar diretamente opportunity.service.js /
// opportunityNextAction.validator.js / opportunityEvents.service.js conforme necessário.

const opportunityService = require('./opportunity.service');
const { isActiveStage, assertNextActionWhenActive, CLOSED_STAGES } = require('./opportunityNextAction.validator');
const outcomeReasons = require('./opportunityOutcomeReason.validator');
const stages = require('./opportunityStages');

module.exports = {
  ...opportunityService,
  isActiveStage,
  assertNextActionWhenActive,
  CLOSED_STAGES,
  // Livro do Marco 3 §10 — catálogo fechado do funil.
  STAGES: stages.STAGES,
  ACTIVE_STAGES: stages.ACTIVE_STAGES,
  normalizeStage: stages.normalizeStage,
  // M3-12 — motivos padrão de ganho/perda/desistência (as listas da empresa são parâmetros: crm.params.js).
  WON_REASONS: outcomeReasons.WON_REASONS,
  LOST_REASONS: outcomeReasons.LOST_REASONS,
  WITHDRAWN_REASONS: outcomeReasons.WITHDRAWN_REASONS,
  OUTCOME_STAGES: outcomeReasons.OUTCOME_STAGES,
  resolveOutcomeReason: outcomeReasons.resolveOutcomeReason,
};
