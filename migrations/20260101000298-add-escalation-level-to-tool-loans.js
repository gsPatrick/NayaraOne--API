'use strict';

/**
 * EST-TS-13 ("ferramenta atrasada gera tarefa/escalonamento") — toolLoanOverdueJob.js hoje só
 * fazia uma transição única OPEN -> OVERDUE com uma Notification solta, sem níveis crescentes
 * nem Task real (diferente do padrão já usado em warrantyEscalationJob.js/computeEscalationLevel
 * para WarrantyCase). `escalation_level` guarda o nível atual (NONE/WARNING/CRITICAL/OVERDUE,
 * calculado a partir de quantos dias já passaram do due_at) para o job recalcular
 * periodicamente e decidir quando notificar/criar Task — mesmo padrão de
 * `construction.maintenance_cases.escalation_level`.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'tool_loans', schema: 'inventory' },
      'escalation_level',
      {
        type: Sequelize.STRING(16),
        allowNull: true,
        defaultValue: 'NONE',
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'tool_loans', schema: 'inventory' }, 'escalation_level');
  },
};
