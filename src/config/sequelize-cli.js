'use strict';

const path = require('path');

require('dotenv').config();
// FIX (Marco 3, verificação cética 11/10/2026): `--env migration` nunca mapeava para um bloco
// real deste arquivo (só development/test/staging/production existiam), e mesmo que mapeasse,
// `.env.migration.local` nunca era carregado — só `.env`. Resultado: qualquer tentativa de rodar
// uma migration com a credencial de DDL dedicada (`DB_MIGRATION_USER`/`DB_MIGRATION_PASSWORD`,
// que tem permissão de ALTER TABLE/CREATE INDEX que a credencial de runtime não tem) caía
// silenciosamente em `production` via `DATABASE_URL` (a credencial de runtime, sem DDL).
// `override: false` por padrão do dotenv: se a variável já existir em `.env`/ambiente, o arquivo
// local não a sobrescreve — mas aqui as chaves são deliberadamente diferentes
// (DB_MIGRATION_USER/DB_MIGRATION_PASSWORD) para nunca colidir com DB_USER/DB_PASSWORD.
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.migration.local') });

const {
  DATABASE_URL,
  DB_HOST,
  DB_PORT,
  DB_NAME,
  DB_USER,
  DB_PASSWORD,
  DB_SSL,
  DB_MIGRATION_USER,
  DB_MIGRATION_PASSWORD,
} = process.env;

const dialectOptions = {
  ssl:
    DB_SSL === 'true'
      ? {
          require: true,
          rejectUnauthorized: false,
        }
      : undefined,
  useUTC: true,
};

function buildEnvConfig() {
  if (DATABASE_URL) {
    return {
      use_env_variable: 'DATABASE_URL',
      dialect: 'postgres',
      dialectOptions,
      define: { underscored: true, freezeTableName: true },
    };
  }
  return {
    username: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    host: DB_HOST || 'localhost',
    port: Number(DB_PORT) || 5432,
    dialect: 'postgres',
    dialectOptions,
    define: { underscored: true, freezeTableName: true },
  };
}

const config = buildEnvConfig();

/**
 * migration — ambiente dedicado para `npx sequelize-cli ... --env migration`, usando a
 * credencial de DDL (`DB_MIGRATION_USER`/`DB_MIGRATION_PASSWORD`, de `.env.migration.local`)
 * em vez da credencial de runtime da aplicação, que não tem (e não deve ter) permissão de
 * ALTER TABLE/CREATE INDEX. Reaproveita host/porta/nome do banco de `.env` normal — só o
 * usuário/senha mudam. Se a credencial de DDL não estiver configurada, cai para `undefined`
 * explicitamente (em vez de mascarar com a credencial de runtime) para o erro ficar óbvio.
 */
const migrationConfig =
  DB_MIGRATION_USER && DB_MIGRATION_PASSWORD
    ? {
        username: DB_MIGRATION_USER,
        password: DB_MIGRATION_PASSWORD,
        database: DB_NAME,
        host: DB_HOST || 'localhost',
        port: Number(DB_PORT) || 5432,
        dialect: 'postgres',
        dialectOptions,
        define: { underscored: true, freezeTableName: true },
      }
    : undefined;

module.exports = {
  development: config,
  test: config,
  staging: config,
  production: config,
  migration: migrationConfig,
};
