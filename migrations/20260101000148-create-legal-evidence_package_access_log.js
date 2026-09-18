'use strict';

/**
 * Migration: cria "legal"."evidence_package_access_log" (M5-28) — cadeia de custódia do
 * dossiê de provas: quem visualizou/exportou, quando. Append-only puro (sem updated_at, sem
 * soft delete): um registro de acesso nunca é editado nem apagado, senão a cadeia de custódia
 * não vale nada como prova.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'evidence_package_access_log', schema: 'legal' },
      {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
          allowNull: false,
        },
        group_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        company_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        evidence_package_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'evidence_packages', schema: 'legal' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        accessed_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        action: {
          type: Sequelize.STRING(16),
          allowNull: false,
          comment: 'VIEWED|EXPORTED',
        },
        accessed_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.sequelize.query('ALTER TABLE "legal"."evidence_package_access_log" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."evidence_package_access_log" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "legal"."evidence_package_access_log"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "legal"."evidence_package_access_log";');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."evidence_package_access_log" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'evidence_package_access_log', schema: 'legal' });
  },
};
