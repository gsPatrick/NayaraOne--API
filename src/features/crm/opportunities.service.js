'use strict';

// Barrel fino: reexporta o CRUD de Opportunity e seus colaboradores especializados
// (validação de next_action / publicação de domain events), mantendo um único ponto de
// entrada estável para quem já dependia de `opportunities.service.js` (ex.: testes de
// integração). Novo código deve preferir importar diretamente opportunity.service.js /
// opportunityNextAction.validator.js / opportunityEvents.service.js conforme necessário.

const opportunityService = require('./opportunity.service');
const { isActiveStage, assertNextActionWhenActive, CLOSED_STAGES } = require('./opportunityNextAction.validator');

module.exports = {
  ...opportunityService,
  isActiveStage,
  assertNextActionWhenActive,
  CLOSED_STAGES,
};
