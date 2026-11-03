'use strict';

/**
 * M6-59 — campos de alerta de evidência reutilizada em Nonconformity. A regra é "gerar alerta",
 * não bloquear — por isso são campos informativos, nunca uma constraint que impeça o INSERT.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(
      { tableName: 'nonconformities', schema: 'construction' },
      'evidence_reuse_flagged',
      { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false }
    );
    await queryInterface.addColumn(
      { tableName: 'nonconformities', schema: 'construction' },
      'evidence_reuse_reference_id',
      { type: Sequelize.UUID, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'nonconformities', schema: 'construction' },
      'evidence_reuse_details',
      { type: Sequelize.JSONB, allowNull: true }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn({ tableName: 'nonconformities', schema: 'construction' }, 'evidence_reuse_flagged');
    await queryInterface.removeColumn({ tableName: 'nonconformities', schema: 'construction' }, 'evidence_reuse_reference_id');
    await queryInterface.removeColumn({ tableName: 'nonconformities', schema: 'construction' }, 'evidence_reuse_details');
  },
};
