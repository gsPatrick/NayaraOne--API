'use strict';

/**
 * Migration: cria "legal"."guarantees" — Garantia locatícia vinculada a um contrato
 * (fiador, seguro-fiança, depósito caução, título de capitalização).
 *
 * DECISÃO DE ENGENHARIA (não extraída literalmente de nenhum doc): schema novo, desenhado
 * seguindo exatamente o estilo das migrations legal existentes (ex.:
 * 20260101000041-create-legal-legal_cases.js) — RLS ENABLE+FORCE com policy tenant_isolation
 * idêntica, colunas de auditoria (created_by/updated_by/deleted_by + soft delete via
 * deleted_at) e lock_version para controle de concorrência otimista, mesmo padrão do restante
 * do schema legal.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'guarantees', schema: 'legal' },
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
        contract_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'contracts', schema: 'legal' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        guarantee_type: {
          type: Sequelize.STRING(32),
          allowNull: false,
          comment: "GUARANTOR|INSURANCE|DEPOSIT|CAPITALIZATION_TITLE",
        },
        guarantor_person_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'persons', schema: 'people' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        value: {
          type: Sequelize.DECIMAL(18, 2),
          allowNull: true,
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'ACTIVE',
        },
        starts_at: {
          type: Sequelize.DATEONLY,
          allowNull: true,
        },
        ends_at: {
          type: Sequelize.DATEONLY,
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

    // DB-002/DB-BLIND-002: toda tabela multiempresa tem RLS ENABLE + FORCE, política deny-by-default.
    await queryInterface.sequelize.query('ALTER TABLE "legal"."guarantees" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."guarantees" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "legal"."guarantees"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "legal"."guarantees";');
    await queryInterface.sequelize.query('ALTER TABLE "legal"."guarantees" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'guarantees', schema: 'legal' });
  },
};
