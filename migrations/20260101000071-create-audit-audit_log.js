'use strict';

/** Migration: cria "audit"."audit_log" — Trilha de auditoria append-only — nunca UPDATE/DELETE por usuário comum. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query('CREATE SCHEMA IF NOT EXISTS "audit";');

    await queryInterface.createTable(
      { tableName: 'audit_log', schema: 'audit' },
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
        user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'core' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        action: {
          type: Sequelize.STRING(64),
          allowNull: false,
        },
        entity_type: {
          type: Sequelize.STRING(128),
          allowNull: false,
        },
        entity_id: {
          type: Sequelize.UUID,
          allowNull: true,
        },
        before_json: {
          type: Sequelize.JSONB,
          allowNull: true,
        },
        after_json: {
          type: Sequelize.JSONB,
          allowNull: true,
        },
        reason: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        occurred_at: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        session_id: {
          type: Sequelize.UUID,
          allowNull: true,
        },
        ip_address: {
          type: Sequelize.STRING(64),
          allowNull: true,
        },
        correlation_id: {
          type: Sequelize.UUID,
          allowNull: true,
        },
        rule_version_id: {
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
    await queryInterface.sequelize.query('ALTER TABLE "audit"."audit_log" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "audit"."audit_log" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "audit"."audit_log"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "audit"."audit_log";');
    await queryInterface.sequelize.query('ALTER TABLE "audit"."audit_log" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'audit_log', schema: 'audit' });
  },
};
