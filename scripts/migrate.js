#!/usr/bin/env node
'use strict';

/**
 * Executor único das migrations (M4-D140, regra 9): lê `migrations/` e `src/modules/finance/infrastructure/db/migrations/`
 * (src/config/migrationDirs.js) e aplica na ordem global do nome do arquivo, com o próprio sequelize-cli (mesma
 * configuração de src/config/sequelize-cli.js, mesmo --env, mesma tabela SequelizeMeta, mesmos --to/--name).
 *
 *   node scripts/migrate.js [up|status|undo|undo:all] [opções do sequelize-cli, ex.: --env migration]
 *   npm run migrate | migrate:status | migrate:undo | migrate:undo:all  (atalhos)
 *
 * O .sequelizerc também chama installMultiDirMigrations(), então o comando direto
 * `npx sequelize-cli db:migrate --env migration` continua lendo as duas pastas, do mesmo jeito.
 * Como funciona: o sequelize-cli monta um Umzug com UMA pasta (migrations-path); este módulo faz o Umzug que o
 * próprio sequelize-cli carrega listar as migrations das duas pastas quando a pasta pedida é a raiz `migrations/`
 * (seeders e qualquer outra pasta seguem como antes). Nome repetido nas duas pastas é erro (nunca aplica duas vezes).
 */
const path = require('node:path');
const { MIGRATION_DIRS, ROOT_MIGRATIONS_DIR } = require('../src/config/migrationDirs');

const COMANDOS = Object.freeze({ up: 'db:migrate', status: 'db:migrate:status', undo: 'db:migrate:undo', 'undo:all': 'db:migrate:undo:all' });

function fromCli(modulo) {
  const cliDir = path.dirname(require.resolve('sequelize-cli/package.json'));
  const umzugDir = path.dirname(require.resolve('umzug/package.json', { paths: [cliDir] }));
  return modulo === 'umzug' ? require(require.resolve('umzug', { paths: [cliDir] })) : require(require.resolve(modulo, { paths: [umzugDir] }));
}

function installMultiDirMigrations() {
  const Umzug = fromCli('umzug');
  if (Umzug.prototype.__nayaraMultiDir) return Umzug;
  const Bluebird = fromCli('bluebird');
  const original = Umzug.prototype._findMigrations;
  Umzug.prototype._findMigrations = function findMigrationsInAllDirs(migrationPath) {
    const opts = this.options.migrations;
    if (migrationPath || Array.isArray(opts) || path.resolve(opts.path) !== ROOT_MIGRATIONS_DIR) return original.call(this, migrationPath);
    return Bluebird.all(MIGRATION_DIRS.map((dir) => original.call(this, dir))).then((lists) => {
      const all = [].concat(...lists);
      const seen = new Map();
      for (const migration of all) {
        if (seen.has(migration.file)) {
          throw new Error(`Migration com o mesmo nome em duas pastas: ${migration.file} (${seen.get(migration.file)} e ${migration.path}).`);
        }
        seen.set(migration.file, migration.path);
      }
      return all.sort((a, b) => (a.file > b.file ? 1 : a.file < b.file ? -1 : 0));
    });
  };
  Object.defineProperty(Umzug.prototype, '__nayaraMultiDir', { value: true });
  return Umzug;
}

module.exports = { installMultiDirMigrations, COMANDOS };

if (require.main === module) {
  const [comando = 'up', ...resto] = process.argv.slice(2);
  if (!COMANDOS[comando]) {
    console.error(`Uso: node scripts/migrate.js [${Object.keys(COMANDOS).join('|')}] [opções do sequelize-cli]`);
    process.exit(2);
  }
  installMultiDirMigrations();
  const bin = require.resolve('sequelize-cli/lib/sequelize');
  process.argv = [process.argv[0], bin, COMANDOS[comando], ...resto];
  require(bin);
}
