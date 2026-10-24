'use strict';

/**
 * Migration: cria "construction"."measurement_items" — itens de uma medição (M6-11).
 * Antes, a medição era uma linha única (só `measured_pct`); agora carrega uma lista de itens
 * (descrição/quantidade/preço unitário/total), e `stage_measurements.total_amount` é a soma
 * desses itens — é esse total que vira o valor da obrigação financeira ao aprovar.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'measurement_items', schema: 'construction' },
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
        measurement_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'stage_measurements', schema: 'construction' }, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        description: {
          type: Sequelize.STRING(255),
          allowNull: false,
        },
        quantity: {
          type: Sequelize.DECIMAL(18, 4),
          allowNull: false,
        },
        unit_price: {
          type: Sequelize.DECIMAL(18, 2),
          allowNull: false,
        },
        total: {
          type: Sequelize.DECIMAL(18, 2),
          allowNull: false,
        },
        created_by: { type: Sequelize.UUID, allowNull: true },
        updated_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    await queryInterface.addIndex(
      { tableName: 'measurement_items', schema: 'construction' },
      ['measurement_id'],
      { name: 'measurement_items_measurement_id_idx' }
    );

    await queryInterface.sequelize.query('ALTER TABLE "construction"."measurement_items" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."measurement_items" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "construction"."measurement_items"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "construction"."measurement_items";');
    await queryInterface.sequelize.query('ALTER TABLE "construction"."measurement_items" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'measurement_items', schema: 'construction' });
  },
};
