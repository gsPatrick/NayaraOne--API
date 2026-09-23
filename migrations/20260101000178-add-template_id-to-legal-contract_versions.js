'use strict';

/**
 * Migration: adiciona `template_id` (nullable, FK -> legal.contract_templates) em
 * "legal"."contract_versions". Decisão: o vínculo fica na VERSÃO, não no Contract — é a
 * versão do documento que nasce (ou não) de um modelo específico; o Contract em si pode ter
 * versões geradas de templates diferentes ao longo do tempo (aditivos, renegociação).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'contract_versions', schema: 'legal' },
      'template_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'contract_templates', schema: 'legal' }, key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'contract_versions', schema: 'legal' }, 'template_id');
  },
};
