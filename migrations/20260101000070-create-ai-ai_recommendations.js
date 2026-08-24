'use strict';

/** Migration: cria "ai"."ai_recommendations" — Recomendação/proposta gerada por um agente da NAY, sujeita a aprovação humana quando crítica. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'ai_recommendations', schema: 'ai' },
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
        ai_run_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'ai_runs', schema: 'ai' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        related_entity_type: {
          type: Sequelize.STRING(64),
          allowNull: false,
        },
        related_entity_id: {
          type: Sequelize.UUID,
          allowNull: false,
        },
        recommendation_type: {
          type: Sequelize.STRING(64),
          allowNull: false,
        },
        payload_json: {
          type: Sequelize.JSONB,
          allowNull: true,
        },
        risk_level: {
          type: Sequelize.STRING(16),
          allowNull: false,
          defaultValue: 'LOW',
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'PENDING',
        },
        decided_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
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
    await queryInterface.sequelize.query('ALTER TABLE "ai"."ai_recommendations" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "ai"."ai_recommendations" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "ai"."ai_recommendations"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "ai"."ai_recommendations";');
    await queryInterface.sequelize.query('ALTER TABLE "ai"."ai_recommendations" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'ai_recommendations', schema: 'ai' });
  },
};
