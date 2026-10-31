'use strict';

/**
 * Marco 7 — SKU único por empresa SEM diferenciar maiúsculas/minúsculas.
 *
 * O serviço já recusava SKU repetido com iLike, mas o índice único do banco era
 * (company_id, sku) e aceitava "abc" ao lado de "ABC" — foi assim que o resíduo
 * AUDIT-M7C-CIM-01 / audit-m7c-cim-01 entrou (saneado em 11ff461). Este índice fecha a
 * regra também no banco, para qualquer caminho de escrita.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_company_id_sku_lower_unique
        ON inventory.inventory_items (company_id, lower(sku))
        WHERE sku IS NOT NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS inventory.inventory_items_company_id_sku_lower_unique;');
  },
};
