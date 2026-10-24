'use strict';

/**
 * Rodada 47 — auditoria "loop até secar" (2026-10-05): TAB-0750 do contrato exige
 * UNIQUE(company_id, sku) e numeric(18,4) para quantity_on_hand/minimum_stock — o schema real
 * tinha DECIMAL(9,6) (overflow em itens com estoque > 999 unidades) e nenhuma unicidade de SKU.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addIndex(
      { tableName: 'inventory_items', schema: 'inventory' },
      ['company_id', 'sku'],
      { name: 'inventory_items_company_id_sku_unique', unique: true, where: { sku: { [Sequelize.Op.ne]: null } } }
    );
    await queryInterface.changeColumn(
      { tableName: 'inventory_items', schema: 'inventory' },
      'minimum_quantity',
      { type: Sequelize.DECIMAL(18, 4), allowNull: true }
    );
    await queryInterface.changeColumn(
      { tableName: 'inventory_items', schema: 'inventory' },
      'quantity_on_hand',
      { type: Sequelize.DECIMAL(18, 4), allowNull: false, defaultValue: 0 }
    );
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex({ tableName: 'inventory_items', schema: 'inventory' }, 'inventory_items_company_id_sku_unique');
    await queryInterface.changeColumn(
      { tableName: 'inventory_items', schema: 'inventory' },
      'minimum_quantity',
      { type: Sequelize.DECIMAL(9, 6), allowNull: true }
    );
    await queryInterface.changeColumn(
      { tableName: 'inventory_items', schema: 'inventory' },
      'quantity_on_hand',
      { type: Sequelize.DECIMAL(9, 6), allowNull: false, defaultValue: 0 }
    );
  },
};
