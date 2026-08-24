'use strict';

require('dotenv').config();

/**
 * Configuração usada exclusivamente pelo sequelize-cli (migrations/seeders).
 * A aplicação em runtime usa src/config/database.js — mantidos separados porque
 * o sequelize-cli exige um módulo CommonJS simples exportando por ambiente,
 * sem instanciar Sequelize diretamente.
 */

const {
  DATABASE_URL,
  DB_HOST,
  DB_PORT,
  DB_NAME,
  DB_USER,
  DB_PASSWORD,
  DB_SSL,
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

module.exports = {
  development: config,
  test: config,
  staging: config,
  production: config,
};
