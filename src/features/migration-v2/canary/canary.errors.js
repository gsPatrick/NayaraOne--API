'use strict';

const { govError, govNotFound } = require('../../core-governance/governance.errors');

/** Erros do canary por setor (M9-D904 §4). Códigos novos levam GOV_. */
module.exports = {
  blockersOpen: (details) => govError(409, 'GOV_CANARY_BLOCKERS_OPEN', 'Há pendências bloqueantes neste setor.', details),
  comparisonPending: (details) => govError(409, 'GOV_CANARY_COMPARISON_PENDING', 'A última comparação paralela deste setor não está limpa.', details),
  stepInvalid: (details) => govError(422, 'GOV_CANARY_STEP_INVALID', 'Etapa de ativação inválida.', details),
  reasonRequired: () => govError(422, 'GOV_CANARY_REASON_REQUIRED', 'Informe o motivo do retorno.'),
  sectorUnknown: (sector) => govNotFound(`Setor desconhecido${sector ? `: ${String(sector).slice(0, 40)}` : ''}.`),
};
