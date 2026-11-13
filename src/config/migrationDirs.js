'use strict';

/**
 * Pastas de migrations da API, na ordem em que o executor as lê (M4-D140, Guia do Marco 4 §2): a raiz `migrations/`
 * e a pasta do módulo financeiro `src/modules/finance/infrastructure/db/migrations/`. O executor (scripts/migrate.js,
 * também ligado ao `sequelize-cli` pelo .sequelizerc) junta as duas e aplica tudo na ordem global do nome do arquivo;
 * a SequelizeMeta guarda só o nome, por isso mover uma migration de pasta não a reexecuta.
 */
const fs = require('node:fs');
const path = require('node:path');

const API_ROOT = path.resolve(__dirname, '..', '..');
const ROOT_MIGRATIONS_DIR = path.join(API_ROOT, 'migrations');
const FINANCE_MIGRATIONS_DIR = path.join(API_ROOT, 'src', 'modules', 'finance', 'infrastructure', 'db', 'migrations');
const MIGRATION_DIRS = Object.freeze([ROOT_MIGRATIONS_DIR, FINANCE_MIGRATIONS_DIR]);

/** Todas as migrations (.js) das pastas acima, em ordem global de nome: [{ name, dir, file }]. */
function listMigrationFiles() {
  const all = [];
  for (const dir of MIGRATION_DIRS) {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.js') && fs.statSync(path.join(dir, name)).isFile()) all.push({ name, dir, file: path.join(dir, name) });
    }
  }
  return all.sort((a, b) => (a.name > b.name ? 1 : a.name < b.name ? -1 : 0));
}

/** Caminho do arquivo de uma migration pelo nome (com ou sem .js), em qualquer das pastas. */
function migrationPath(name) {
  const file = name.endsWith('.js') ? name : `${name}.js`;
  const found = MIGRATION_DIRS.map((dir) => path.join(dir, file)).find((p) => fs.existsSync(p));
  if (!found) throw new Error(`Migration não encontrada: ${file}`);
  return found;
}

module.exports = { API_ROOT, ROOT_MIGRATIONS_DIR, FINANCE_MIGRATIONS_DIR, MIGRATION_DIRS, listMigrationFiles, migrationPath };
