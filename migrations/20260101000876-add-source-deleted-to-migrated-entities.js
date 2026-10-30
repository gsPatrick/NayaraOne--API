'use strict';

/**
 * M9-D900 — exclusão lógica vinda da origem: people.persons e real_estate.properties ganham `source_deleted` (e a data). O evento D do CDC e a comparação de chaves marcam a
 * linha de destino e nunca a apagam. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      for (const table of ['people.persons', 'real_estate.properties']) {
        await q(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS source_deleted boolean NOT NULL DEFAULT false`);
        await q(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS source_deleted_at timestamptz NULL`);
      }
    });
  },
  async down(queryInterface) {
    for (const table of ['people.persons', 'real_estate.properties']) {
      await queryInterface.sequelize.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS source_deleted_at, DROP COLUMN IF EXISTS source_deleted`);
    }
  },
};
