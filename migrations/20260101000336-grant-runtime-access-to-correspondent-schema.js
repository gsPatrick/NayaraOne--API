'use strict';

/**
 * Migration: concede a nayara_runtime o acesso ao schema "correspondent" — mesmo gap já
 * corrigido para "procurement" em 20260101000269 (todo schema novo não recebe o GRANT
 * automático que os schemas originais do projeto têm fora de migration). Sem isso, toda chamada
 * real à API bateria em "permission denied for schema correspondent".
 */
module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_migration') THEN
          CREATE ROLE nayara_migration;
        END IF;
      END
      $$;
    `);
    const [[{ exists }]] = await sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (exists) {
      await sequelize.query('GRANT USAGE ON SCHEMA "correspondent" TO nayara_runtime;');
      await sequelize.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "correspondent" TO nayara_runtime;');
      await sequelize.query('ALTER DEFAULT PRIVILEGES FOR ROLE nayara_migration IN SCHEMA "correspondent" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nayara_runtime;');
    }
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    const [[{ exists }]] = await sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (exists) {
      await sequelize.query('ALTER DEFAULT PRIVILEGES FOR ROLE nayara_migration IN SCHEMA "correspondent" REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM nayara_runtime;');
      await sequelize.query('REVOKE SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "correspondent" FROM nayara_runtime;');
      await sequelize.query('REVOKE USAGE ON SCHEMA "correspondent" FROM nayara_runtime;');
    }
  },
};
