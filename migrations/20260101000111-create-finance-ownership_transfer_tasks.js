'use strict';

/**
 * Migration: cria "finance"."ownership_transfer_tasks" — tarefa de transferência de
 * titularidade de uma utilidade ao mudar locatário/proprietário (M07 Billing
 * Locação/Utilities). O closeout de locação (closeout.service.js) verifica se existe alguma
 * tarefa aqui com status != COMPLETED antes de liberar o encerramento do contrato.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'ownership_transfer_tasks', schema: 'finance' },
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
        from_person_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'persons', schema: 'people' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        to_person_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'persons', schema: 'people' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'PENDING',
          comment: 'PENDING|COMPLETED',
        },
        completed_at: { type: Sequelize.DATE, allowNull: true },
        lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.sequelize.query('ALTER TABLE "finance"."ownership_transfer_tasks" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."ownership_transfer_tasks" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."ownership_transfer_tasks"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."ownership_transfer_tasks";');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."ownership_transfer_tasks" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'ownership_transfer_tasks', schema: 'finance' });
  },
};
