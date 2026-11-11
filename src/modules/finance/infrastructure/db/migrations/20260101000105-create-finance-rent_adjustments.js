'use strict';

/**
 * Migration: cria "finance"."rent_adjustments" — reajuste de aluguel (M07 Billing
 * Locação/Utilities). `raw` (índice bruto) vs `applied` (percentual efetivamente aplicado,
 * pode divergir por negociação) são colunas separadas de propósito — nunca se assume que
 * raw == applied.
 *
 * status default é 'PENDING_SOURCE': quando o adapter de índice (ver
 * src/features/billing/adapters/IndexSourceAdapter.js) não tem o índice disponível para
 * `index_code`/`period`, o registro FICA em PENDING_SOURCE com raw_index_value/new_rent_amount
 * NULL — o serviço nunca inventa um percentual (ver rentAdjustment.service.js).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'rent_adjustments', schema: 'finance' },
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
        contract_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'contracts', schema: 'legal' }, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        index_code: {
          type: Sequelize.STRING(32),
          allowNull: false,
          comment: 'Texto livre, ex.: IGPM, IPCA.',
        },
        period: { type: Sequelize.STRING(7), allowNull: false, comment: 'Competência do índice, YYYY-MM.' },
        raw_index_value: { type: Sequelize.DECIMAL(12, 6), allowNull: true },
        applied_percentage: { type: Sequelize.DECIMAL(12, 6), allowNull: true },
        old_rent_amount: { type: Sequelize.DECIMAL(18, 2), allowNull: false },
        new_rent_amount: { type: Sequelize.DECIMAL(18, 2), allowNull: true },
        rule_version_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'rule_versions', schema: 'core' }, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: 'PENDING_SOURCE',
          comment: 'PENDING_SOURCE|APPLIED',
        },
        applied_at: { type: Sequelize.DATE, allowNull: true },
        lock_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        deleted_by: { type: Sequelize.UUID, allowNull: true },
        deleted_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.sequelize.query(`
      ALTER TABLE "finance"."rent_adjustments" ADD CONSTRAINT rent_adjustments_contract_period_unique UNIQUE (contract_id, period);
    `);

    await queryInterface.sequelize.query('ALTER TABLE "finance"."rent_adjustments" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."rent_adjustments" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."rent_adjustments"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."rent_adjustments";');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."rent_adjustments" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'rent_adjustments', schema: 'finance' });
  },
};
