'use strict';

/**
 * Migration: adiciona constraint única em "finance"."approval_steps" (approval_request_id,
 * approver_user_id).
 *
 * FIX (achado 18/09/2026, teste de concorrência real — M4-24): decideApprovalStep checava
 * "o aprovador já decidiu?" via SELECT no início da função e só fazia INSERT depois — sob
 * concorrência real (duplo-clique, duas abas, retry de rede), duas transações podiam passar
 * pelo SELECT ao mesmo tempo (nenhuma via a decisão da outra ainda) e as duas inserirem,
 * duplicando a decisão do mesmo aprovador pra mesma solicitação. Confirmado com teste real:
 * 2 decisões concorrentes do mesmo aprovador, as duas passavam. Constraint única no banco é a
 * única forma de fechar essa corrida de verdade — a segunda tentativa vai bater na constraint e
 * ser convertida em erro de negócio (FINANCE_APPROVAL_DUPLICATE_DECISION) pelo service.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.addConstraint(
      { tableName: 'approval_steps', schema: 'finance' },
      {
        fields: ['approval_request_id', 'approver_user_id'],
        type: 'unique',
        name: 'approval_steps_request_approver_uk',
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeConstraint({ tableName: 'approval_steps', schema: 'finance' }, 'approval_steps_request_approver_uk');
  },
};
