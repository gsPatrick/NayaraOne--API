'use strict';

/**
 * Migration (M6-15/M6-16/M6-26/M6-63/M6-88): estrutura "construction"."maintenance_cases"
 * (WarrantyCase) com os campos que faltavam para um chamado de garantia/pós-obra de verdade —
 * categoria, severidade, SLA calculado, mídias de antes/depois, custos de mão de obra e
 * material, causa raiz e nível de escalonamento de SLA. Mantém a tabela existente (ALTER, não
 * DROP/CREATE) para não perder chamados já abertos.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'maintenance_cases', schema: 'construction' },
      'category',
      {
        // Enum simples "configurável" (STRING livre, igual ao padrão já usado em `status`
        // desta mesma tabela) — não há lista fechada nos documentos fonte.
        type: Sequelize.STRING(64),
        allowNull: true,
      }
    );
    await queryInterface.addColumn(
      { tableName: 'maintenance_cases', schema: 'construction' },
      'severity',
      {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'MEDIUM',
      }
    );
    await queryInterface.addColumn(
      { tableName: 'maintenance_cases', schema: 'construction' },
      'sla_due_at',
      {
        // Calculado em código a partir de warranty_deadline_at + prazo por severidade (ver
        // maintenanceCases.service.js#computeSlaDueAt), mas guardado como coluna própria para
        // permitir index/consulta direta pelo job de escalonamento (mesmo padrão de
        // crm.feedback_cases.sla_due_at).
        type: Sequelize.DATE,
        allowNull: true,
      }
    );
    await queryInterface.addColumn(
      { tableName: 'maintenance_cases', schema: 'construction' },
      'escalation_level',
      {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'NONE',
      }
    );
    await queryInterface.addColumn(
      { tableName: 'maintenance_cases', schema: 'construction' },
      'before_media_file_ids',
      {
        type: Sequelize.ARRAY(Sequelize.UUID),
        allowNull: false,
        defaultValue: [],
      }
    );
    await queryInterface.addColumn(
      { tableName: 'maintenance_cases', schema: 'construction' },
      'after_media_file_ids',
      {
        type: Sequelize.ARRAY(Sequelize.UUID),
        allowNull: false,
        defaultValue: [],
      }
    );
    await queryInterface.addColumn(
      { tableName: 'maintenance_cases', schema: 'construction' },
      'labor_cost',
      {
        type: Sequelize.DECIMAL(14, 2),
        allowNull: true,
      }
    );
    await queryInterface.addColumn(
      { tableName: 'maintenance_cases', schema: 'construction' },
      'material_cost',
      {
        type: Sequelize.DECIMAL(14, 2),
        allowNull: true,
      }
    );
    await queryInterface.addColumn(
      { tableName: 'maintenance_cases', schema: 'construction' },
      'root_cause_code',
      {
        type: Sequelize.STRING(64),
        allowNull: true,
      }
    );

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS maintenance_cases_sla_due_at_idx
        ON "construction"."maintenance_cases" (sla_due_at)
        WHERE deleted_at IS NULL;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "construction".maintenance_cases_sla_due_at_idx;');
    const table = { tableName: 'maintenance_cases', schema: 'construction' };
    await queryInterface.removeColumn(table, 'root_cause_code');
    await queryInterface.removeColumn(table, 'material_cost');
    await queryInterface.removeColumn(table, 'labor_cost');
    await queryInterface.removeColumn(table, 'after_media_file_ids');
    await queryInterface.removeColumn(table, 'before_media_file_ids');
    await queryInterface.removeColumn(table, 'escalation_level');
    await queryInterface.removeColumn(table, 'sla_due_at');
    await queryInterface.removeColumn(table, 'severity');
    await queryInterface.removeColumn(table, 'category');
  },
};
