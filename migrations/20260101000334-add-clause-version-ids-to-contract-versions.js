'use strict';

/**
 * GAP REAL (verificação cética Marco 5, §3 do Caderno: "Versão gerada do contrato guarda
 * template_version_id, clause_version_ids e conteúdo/hash final") — legal.contract_versions
 * nunca teve a coluna clause_version_ids. Idempotente.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const [cols] = await queryInterface.sequelize.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'legal' AND table_name = 'contract_versions' AND column_name = 'clause_version_ids'`
    );
    if (!cols.length) {
      await queryInterface.addColumn(
        { tableName: 'contract_versions', schema: 'legal' },
        'clause_version_ids',
        { type: Sequelize.JSONB, allowNull: true }
      );
    }
  },
  async down(queryInterface) {
    await queryInterface.removeColumn({ tableName: 'contract_versions', schema: 'legal' }, 'clause_version_ids');
  },
};
