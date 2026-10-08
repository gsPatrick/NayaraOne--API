'use strict';

/**
 * GAP REAL CORRIGIDO (auditoria externa Nayara, 2026-10-08): a checagem de reuso suspeito de
 * evidência por hash (`detectEvidenceReuse`, nonconformities.service.js) nunca foi conectada ao
 * Diário de Obra (RDO) — mesmo o RDO gravando `evidenceFileIds`. Mesmos 3 campos de alerta já
 * usados em `construction.nonconformities` (migration 20260101000246), espelhados aqui. A regra
 * é "gerar alerta", não bloquear — por isso são campos informativos, nunca uma constraint que
 * impeça o INSERT.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(
      { tableName: 'daily_reports', schema: 'construction' },
      'evidence_reuse_flagged',
      { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false }
    );
    await queryInterface.addColumn(
      { tableName: 'daily_reports', schema: 'construction' },
      'evidence_reuse_reference_id',
      { type: Sequelize.UUID, allowNull: true }
    );
    await queryInterface.addColumn(
      { tableName: 'daily_reports', schema: 'construction' },
      'evidence_reuse_details',
      { type: Sequelize.JSONB, allowNull: true }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn({ tableName: 'daily_reports', schema: 'construction' }, 'evidence_reuse_flagged');
    await queryInterface.removeColumn({ tableName: 'daily_reports', schema: 'construction' }, 'evidence_reuse_reference_id');
    await queryInterface.removeColumn({ tableName: 'daily_reports', schema: 'construction' }, 'evidence_reuse_details');
  },
};
