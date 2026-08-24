'use strict';

/** Migration: cria "integration"."domain_events" — Registro append-only do histórico de eventos de domínio já processados internamente (auditoria de fluxo, não é o outbox de transporte). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'domain_events', schema: 'integration' },
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
        payload_json: {
          type: Sequelize.JSONB,
          allowNull: false,
        },
        occurred_at: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        correlation_id: {
          type: Sequelize.UUID,
          allowNull: true,
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    // DB-002/DB-BLIND-002: toda tabela multiempresa tem RLS ENABLE + FORCE, política deny-by-default.
    await queryInterface.sequelize.query('ALTER TABLE "integration"."domain_events" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "integration"."domain_events" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "integration"."domain_events"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "integration"."domain_events";');
    await queryInterface.sequelize.query('ALTER TABLE "integration"."domain_events" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'domain_events', schema: 'integration' });
  },
};
