'use strict';

/** Migration: cria "ai"."knowledge_entries" — Fato estruturado e versionado da memória empresarial da NAY (não é cópia integral de conversa). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'knowledge_entries', schema: 'ai' },
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
        subject_type: {
          type: Sequelize.STRING(64),
          allowNull: false,
        },
        subject_id: {
          type: Sequelize.UUID,
          allowNull: true,
        },
        fact_key: {
          type: Sequelize.STRING(128),
          allowNull: false,
        },
        fact_value_json: {
          type: Sequelize.JSONB,
          allowNull: false,
        },
        origin: {
          type: Sequelize.STRING(64),
          allowNull: true,
        },
        classification: {
          type: Sequelize.STRING(16),
          allowNull: false,
          defaultValue: 'INTERNAL',
        },
        valid_from: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        valid_until: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        is_active: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
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

    // DB-002/DB-BLIND-002: toda tabela multiempresa tem RLS ENABLE + FORCE, política deny-by-default.
    await queryInterface.sequelize.query('ALTER TABLE "ai"."knowledge_entries" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "ai"."knowledge_entries" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "ai"."knowledge_entries"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "ai"."knowledge_entries";');
    await queryInterface.sequelize.query('ALTER TABLE "ai"."knowledge_entries" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'knowledge_entries', schema: 'ai' });
  },
};
