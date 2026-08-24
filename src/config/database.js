'use strict';

const { Sequelize } = require('sequelize');

/**
 * Configuração central do Sequelize para PostgreSQL.
 * - Timezone de armazenamento: UTC (apresentação em America/Sao_Paulo fica a cargo da camada de apresentação).
 * - underscored: true global — colunas em snake_case no banco, camelCase nos models.
 * - Pool configurável via variáveis de ambiente (ver ENV_REFERENCE.md).
 */

const {
  DATABASE_URL,
  DB_HOST,
  DB_PORT,
  DB_NAME,
  DB_USER,
  DB_PASSWORD,
  DB_POOL_MAX,
  DB_POOL_MIN,
  DB_POOL_ACQUIRE_MS,
  DB_POOL_IDLE_MS,
  DB_SSL,
  NODE_ENV,
} = process.env;

const commonOptions = {
  dialect: 'postgres',
  timezone: '+00:00',
  logging: false,
  define: {
    underscored: true,
    freezeTableName: true,
  },
  pool: {
    max: Number(DB_POOL_MAX) || 10,
    min: Number(DB_POOL_MIN) || 0,
    acquire: Number(DB_POOL_ACQUIRE_MS) || 30000,
    idle: Number(DB_POOL_IDLE_MS) || 10000,
  },
  dialectOptions: {
    ssl:
      DB_SSL === 'true'
        ? {
            require: true,
            rejectUnauthorized: false,
          }
        : undefined,
    // Garante que o driver interprete/serialize datas sempre em UTC.
    useUTC: true,
  },
};

let sequelize;

if (DATABASE_URL) {
  sequelize = new Sequelize(DATABASE_URL, commonOptions);
} else {
  sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASSWORD, {
    ...commonOptions,
    host: DB_HOST || 'localhost',
    port: Number(DB_PORT) || 5432,
  });
}

module.exports = { sequelize, isProduction: NODE_ENV === 'production' };
