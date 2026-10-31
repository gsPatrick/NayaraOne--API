'use strict';

const { govError, govNotFound } = require('../../core-governance/governance.errors');

/** Erros do plano de rollback (M9-D907 §4). */
module.exports = {
  compensationRequired: (details) => govError(422, 'GOV_ROLLBACK_COMPENSATION_REQUIRED', 'Defina o procedimento de compensação deste tipo de operação.', details),
  invalid: (message, details) => govError(422, 'GOV_ROLLBACK_INVALID', message, details),
  itemNotFound: () => govNotFound('Item de rollback não encontrado.'),
  itemFinal: (details) => govError(409, 'GOV_ROLLBACK_ITEM_FINAL', 'Este item de rollback já foi resolvido.', details),
  logFailed: (details) => govError(503, 'GOV_ROLLBACK_LOG_FAILED', 'Não foi possível registrar a operação externa; ela não foi enviada.', details),
  notReady: (details) => govError(409, 'GOV_CUTOVER_NOT_READY', 'O corte não pode seguir: há tipos de operação externa sem plano de compensação.', details),
  decisionInvalid: () => govError(422, 'GOV_CUTOVER_DECISION_INVALID', 'Informe a decisão: GO ou NO_GO.'),
};
