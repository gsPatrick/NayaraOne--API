'use strict';

const { govError, govNotFound } = require('../../core-governance/governance.errors');

/** Erros da Torre de controle e das decisões sobre registros (M9-D901 §4). */
module.exports = {
  reasonRequired: () => govError(400, 'GOV_MIG_REASON_REQUIRED', 'Informe a decisão e o motivo.'),
  invalidTransition: (from, decision) => govError(409, 'GOV_MIG_RECORD_INVALID_TRANSITION', 'Transição de estado inválida para o registro migrado.', { from, decision: decision || null }),
  raciForbidden: (onlyAccountable) => govError(
    403, 'GOV_MIG_RACI_FORBIDDEN',
    onlyAccountable ? 'Só quem responde (A) pela reconciliação final pode excluir um registro da migração.' : 'Só quem é responsável (R) ou responde (A) pela reconciliação final pode decidir sobre registros da migração.',
    { activity: 'FINAL_RECONCILIATION' }
  ),
  unapplicable: (reason) => govError(422, 'GOV_MIG_RECORD_UNAPPLICABLE', 'O registro não pode ser aplicado como está.', { reason }),
  runNotFound: () => govNotFound('Execução de migração não encontrada.'),
  recordNotFound: () => govNotFound('Registro de migração não encontrado.'),
};
