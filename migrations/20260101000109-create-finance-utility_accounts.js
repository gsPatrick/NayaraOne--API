'use strict';

/**
 * Migration: cria "finance"."utility_accounts" — cadastro de conta/titularidade junto à
 * concessionária, associada a uma utility_obligation (M07 Billing Locação/Utilities). Separado
 * de utility_obligations porque a MESMA obrigação pode ter titularidades diferentes ao longo
 * do tempo (troca de locatário/proprietário) — ver ownership_transfer_tasks.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'utility_accounts', schema: 'finance' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
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
        utility_obligation_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'utility_obligations', schema: 'finance' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        provider: { type: Sequelize.STRING(120), allowNull: false },
        account_number: { type: Sequelize.STRING(60), allowNull: false },
        holder_person_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'persons', schema: 'people' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'ACTIVE',
          comment: 'ACTIVE|CLOSED',
        },
        lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.sequelize.query('ALTER TABLE "finance"."utility_accounts" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."utility_accounts" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."utility_accounts"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."utility_accounts";');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."utility_accounts" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'utility_accounts', schema: 'finance' });
  },
};
