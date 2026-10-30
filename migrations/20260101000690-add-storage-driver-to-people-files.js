'use strict';

/**
 * Marco 9, M9-D242 — people.files guarda ONDE o objeto foi gravado: o fornecedor de armazenamento (storage_provider) e, quando foi por uma integração da empresa,
 * a connection (storage_connection_id). Assim a troca de driver (M9-D221) não esconde os arquivos já gravados no driver anterior: a leitura vai ao driver que gravou.
 * Linha antiga, anterior à D242, fica com as duas colunas nulas e é lida no disco local (único armazenamento que existia). ADD COLUMN não mexe na RLS FORCE da tabela;
 * o GRANT do runtime já cobre a tabela inteira.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE people.files ADD COLUMN IF NOT EXISTS storage_provider varchar(48) NULL');
      await q('ALTER TABLE people.files ADD COLUMN IF NOT EXISTS storage_connection_id uuid NULL');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE people.files DROP COLUMN IF EXISTS storage_connection_id');
      await q('ALTER TABLE people.files DROP COLUMN IF EXISTS storage_provider');
    });
  },
};
