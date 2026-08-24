'use strict';

/** Migration: cria "integration"."outbox_events" — Transactional Outbox — evento de domínio gravado na mesma transação do dado de negócio, publicado depois no broker. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query('CREATE SCHEMA IF NOT EXISTS "integration";');

    await queryInterface.createTable(
      { tableName: 'outbox_events', schema: 'integration' },
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
        aggregate_type: {
          type: Sequelize.STRING(128),
          allowNull: false,
        },
        aggregate_id: {
          type: Sequelize.UUID,
          allowNull: false,
        },
        event_type: {
          type: Sequelize.STRING(128),
          allowNull: false,
        },
        event_version: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 1,
        },
        payload_json: {
          type: Sequelize.JSONB,
          allowNull: false,
        },
        correlation_id: {
          type: Sequelize.UUID,
          allowNull: true,
        },
        causation_id: {
          type: Sequelize.UUID,
          allowNull: true,
        },
        idempotency_key: {
          type: Sequelize.STRING(128),
          allowNull: false,
          unique: true,
        },
        classification: {
          type: Sequelize.STRING(32),
          allowNull: true,
        },
        occurred_at: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'PENDING',
        },
        retry_count: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        next_retry_at: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        dead_letter_reason: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    // DB-002/DB-BLIND-002: toda tabela multiempresa tem RLS ENABLE + FORCE, política deny-by-default.
    await queryInterface.sequelize.query('ALTER TABLE "integration"."outbox_events" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "integration"."outbox_events" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "integration"."outbox_events"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "integration"."outbox_events";');
    await queryInterface.sequelize.query('ALTER TABLE "integration"."outbox_events" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'outbox_events', schema: 'integration' });
  },
};
