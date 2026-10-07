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
    // nayara_migration é o role usado localmente para rodar migrations com privilégio de DDL;
    // em ambientes provisionados fora do fluxo local (ex.: Easypanel) ele pode não existir
    // ainda — criado aqui, idempotente, só pra não quebrar o ALTER DEFAULT PRIVILEGES abaixo.
    await sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_migration') THEN
          CREATE ROLE nayara_migration;
        END IF;
      END
      $$;
    `);
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
