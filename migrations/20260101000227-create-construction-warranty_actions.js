'use strict';

/**
 * Migration (M6-15/M6-16/M6-26): cria "construction"."warranty_actions" — histórico de ações
 * de atendimento realizadas dentro de um chamado de garantia (visita técnica, reparo, troca de
 * material etc), cada uma com custo próprio. Vinculada a `construction.maintenance_cases` via
 * `warranty_case_id` (mesma tabela física — só ficou "WarrantyCase" na nomenclatura do domínio
 * de garantia, ver comentário em maintenanceCases.service.js).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'warranty_actions', schema: 'construction' },
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
        warranty_case_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'maintenance_cases', schema: 'construction' }, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        description: {
          type: Sequelize.TEXT,
          allowNull: false,
        },
        performed_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        performed_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        cost: {
          type: Sequelize.DECIMAL(14, 2),
          allowNull: true,
        },
        lock_version: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS warranty_actions_warranty_case_id_idx
        ON "construction"."warranty_actions" (warranty_case_id);
    `);

    // DB-002/DB-BLIND-002: toda tabela multiempresa tem RLS ENABLE + FORCE, política deny-by-default.
    await queryInterface.sequelize.query('ALTER TABLE "construction"."warranty_actions" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."warranty_actions" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."warranty_actions"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "construction"."warranty_actions";');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."warranty_actions" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'warranty_actions', schema: 'construction' });
  },
};
