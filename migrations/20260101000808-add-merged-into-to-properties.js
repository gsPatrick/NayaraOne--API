'use strict';

/**
 * M9-D805 — real_estate.properties.merged_into_id: o imóvel absorvido numa união de cadastros aponta para o sobrevivente e nunca é apagado
 * (pessoa e fornecedor já têm people.persons.merged_into_id). Coluna nula por padrão; reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE real_estate.properties ADD COLUMN IF NOT EXISTS merged_into_id uuid NULL REFERENCES real_estate.properties(id) ON UPDATE CASCADE ON DELETE RESTRICT');
      await q('CREATE INDEX IF NOT EXISTS properties_merged_into_id_idx ON real_estate.properties (merged_into_id) WHERE merged_into_id IS NOT NULL');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE real_estate.properties DROP COLUMN IF EXISTS merged_into_id');
  },
};
