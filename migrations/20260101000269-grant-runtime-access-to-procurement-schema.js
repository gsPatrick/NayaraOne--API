'use strict';

/**
 * Migration: concede a nayara_runtime o acesso ao schema "procurement" — BUG REAL ENCONTRADO
 * em teste local: todo outro schema (`inventory`, `construction`, `finance`, etc.) tem
 * `GRANT USAGE ON SCHEMA` para nayara_runtime concedido fora de qualquer migration deste
 * repositório (configuração de infraestrutura do banco, não versionada em código). Como
 * "procurement" é um schema novo criado por este Marco, esse grant nunca foi aplicado e TODA
 * chamada de API batia em "permission denied for schema procurement". Diferente dos demais
 * schemas, aqui o grant fica explícito numa migration — não dependemos mais de configuração
 * manual de infraestrutura para um schema novo funcionar.
 */
module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('GRANT USAGE ON SCHEMA "procurement" TO nayara_runtime;');
    await sequelize.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "procurement" TO nayara_runtime;');
    await sequelize.query('ALTER DEFAULT PRIVILEGES FOR ROLE nayara_migration IN SCHEMA "procurement" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nayara_runtime;');
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('ALTER DEFAULT PRIVILEGES FOR ROLE nayara_migration IN SCHEMA "procurement" REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM nayara_runtime;');
    await sequelize.query('REVOKE SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "procurement" FROM nayara_runtime;');
    await sequelize.query('REVOKE USAGE ON SCHEMA "procurement" FROM nayara_runtime;');
  },
};
