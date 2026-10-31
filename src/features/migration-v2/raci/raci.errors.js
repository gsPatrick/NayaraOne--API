'use strict';

const { govError, govNotFound } = require('../../core-governance/governance.errors');

/** Erros do RACI de cutover (M9-D902 §4). */
module.exports = {
  singleAccountable: (details) => govError(422, 'GOV_RACI_SINGLE_ACCOUNTABLE', 'Cada atividade tem exatamente uma pessoa que responde pelo resultado.', details),
  invalid: (message, details) => govError(422, 'GOV_RACI_INVALID', message || 'RACI inválido.', details),
  activityNotFound: () => govNotFound('Atividade de cutover não encontrada.'),
  activityForbidden: (activity) => govError(403, 'GOV_MIG_RACI_FORBIDDEN', 'Só quem é responsável (R) ou responde (A) por esta atividade do corte pode decidir.', { activity }),
  adminForbidden: () => govError(403, 'PERMISSION_DENIED', 'Permissão ausente: governance:migration:admin.'),
};
