'use strict';

/** Migration: cria "integration"."integration_inbox" — Inbox de deduplicação de consumo de eventos/webhooks externos. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'integration_inbox', schema: 'integration' },
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
        consumer_name: {
          type: Sequelize.STRING(128),
          allowNull: false,
        },
        event_id: {
          type: Sequelize.UUID,
          allowNull: false,
        },
        idempotency_key: {
          type: Sequelize.STRING(128),
          allowNull: false,
          unique: true,
        },
        payload_json: {
          type: Sequelize.JSONB,
          allowNull: true,
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'RECEIVED',
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
    await queryInterface.sequelize.query('ALTER TABLE "integration"."integration_inbox" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "integration"."integration_inbox" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "integration"."integration_inbox"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "integration"."integration_inbox";');
    await queryInterface.sequelize.query('ALTER TABLE "integration"."integration_inbox" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'integration_inbox', schema: 'integration' });
  },
};
