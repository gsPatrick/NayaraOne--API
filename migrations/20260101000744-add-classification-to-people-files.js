'use strict';

/**
 * M9-D022 — people.files ganha a classificação do documento (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED), nula até alguém classificar.
 * A NAY só indexa arquivo classificado e nunca adivinha a classificação (AI-011): a coluna é o "registro do arquivo" de que o livro fala.
 * ADD COLUMN não mexe na RLS FORCE da tabela; o GRANT do runtime já cobre a tabela inteira.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE people.files ADD COLUMN IF NOT EXISTS classification varchar(12) NULL');
      await q('ALTER TABLE people.files DROP CONSTRAINT IF EXISTS files_classification_chk');
      await q("ALTER TABLE people.files ADD CONSTRAINT files_classification_chk CHECK (classification IS NULL OR classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'))");
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE people.files DROP CONSTRAINT IF EXISTS files_classification_chk');
      await q('ALTER TABLE people.files DROP COLUMN IF EXISTS classification');
    });
  },
};
