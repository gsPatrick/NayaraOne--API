'use strict';

/**
 * Migration: Marco 7 fase 6 (Guia do Marcelo §6/§7) — "tool_loans": empréstimo/saída de
 * ferramenta (Asset). OPEN -> RETURNED. Ferramenta já emprestada não pode sair de novo
 * (EST-TS-05) — garantido no service pelo status do Asset (status='LOANED' bloqueia novo loan).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'tool_loans', schema: 'inventory' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
        group_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        company_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        asset_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'assets', schema: 'inventory' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        person_user_id: { type: Sequelize.UUID, allowNull: false, comment: 'Responsável pelo empréstimo.' },
        destination_location_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: { tableName: 'locations', schema: 'inventory' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        due_at: { type: Sequelize.DATE, allowNull: true },
        returned_at: { type: Sequelize.DATE, allowNull: true },
        condition_code: { type: Sequelize.STRING(16), allowNull: true, comment: 'OK|DAMAGED — preenchido na devolução.' },
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'OPEN', comment: 'OPEN|RETURNED|OVERDUE' },
        lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."tool_loans" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."tool_loans" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "inventory"."tool_loans"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "inventory"."tool_loans";');
    await queryInterface.sequelize.query('ALTER TABLE "inventory"."tool_loans" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'tool_loans', schema: 'inventory' });
  },
};
