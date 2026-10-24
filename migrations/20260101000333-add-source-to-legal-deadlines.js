'use strict';

/**
 * GAP REAL (verificação final Marco 5, §15 do Caderno "Prazos jurídicos"): "Prazo sempre tem
 * source_document/source_event" — a tabela legal.legal_deadlines nunca teve essas colunas.
 * Nullable (não pode exigir retroativamente em prazos já existentes), mas o service agora
 * exige pelo menos um dos dois na criação de prazo novo (ver legalDeadlines.service.js).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const [cols] = await queryInterface.sequelize.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'legal' AND table_name = 'legal_deadlines' AND column_name = 'source_document'`
    );
    if (!cols.length) {
      await queryInterface.addColumn(
        { tableName: 'legal_deadlines', schema: 'legal' },
        'source_document',
        { type: Sequelize.STRING(255), allowNull: true }
      );
    }
    const [cols2] = await queryInterface.sequelize.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'legal' AND table_name = 'legal_deadlines' AND column_name = 'source_event'`
    );
    if (!cols2.length) {
      await queryInterface.addColumn(
        { tableName: 'legal_deadlines', schema: 'legal' },
        'source_event',
        { type: Sequelize.STRING(255), allowNull: true }
      );
    }
  },
  async down(queryInterface) {
    await queryInterface.removeColumn({ tableName: 'legal_deadlines', schema: 'legal' }, 'source_document');
    await queryInterface.removeColumn({ tableName: 'legal_deadlines', schema: 'legal' }, 'source_event');
  },
};
