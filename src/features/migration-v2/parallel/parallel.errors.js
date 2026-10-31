'use strict';

const { govError, govNotFound } = require('../../core-governance/governance.errors');

/** Erros da comparação paralela (M9-D903 §4). Códigos novos levam GOV_. */
module.exports = {
  ruleMissing: (field, entity) => govError(422, 'GOV_PARALLEL_RULE_MISSING', `Defina a regra de comparação para o campo ${field}.`, { field, entity }),
  ruleInvalid: (message, details) => govError(422, 'GOV_PARALLEL_RULE_INVALID', message, details),
  windowInvalid: (message, details) => govError(422, 'GOV_PARALLEL_WINDOW_INVALID', message || 'Janela de comparação inválida.', details),
  endBeforeStart: () => govError(422, 'GOV_PARALLEL_WINDOW_INVALID', 'O fim da janela deve ser após o início.'),
  sourceDown: (details) => govError(503, 'GOV_PARALLEL_SOURCE_DOWN', 'A fonte antiga está indisponível; a comparação foi adiada para a próxima execução.', details),
  windowNotFound: () => govNotFound('Janela de comparação não encontrada.'),
};
