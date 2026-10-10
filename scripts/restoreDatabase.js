'use strict';

/**
 * GAP REAL CORRIGIDO (auditoria Marco 6, 08/10/2026 — "restore reproduzível"). Restaura um dump
 * gerado por scripts/backupDatabase.js via pg_restore --clean --if-exists. Exige um nome de
 * banco de DESTINO explícito e recusa rodar se ele bater com o banco principal configurado no
 * ambiente (DB_NAME/DATABASE_URL) — proteção contra sobrescrever acidentalmente produção/dev ao
 * testar um restore.
 *
 * Uso: node scripts/restoreDatabase.js --file <caminho-do-dump> --target-db <nome-do-banco-destino>
 */

require('dotenv').config();
const { execFile } = require('node:child_process');
const { URL } = require('node:url');
const { resolveConnection, resolveBinary } = require('./backupDatabase');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file' && argv[i + 1]) { out.file = argv[i + 1]; i += 1; }
    if (argv[i] === '--target-db' && argv[i + 1]) { out.targetDb = argv[i + 1]; i += 1; }
  }
  return out;
}

async function main() {
  const { file, targetDb } = parseArgs(process.argv.slice(2));
  if (!file || !targetDb) {
    throw new Error('Uso: node scripts/restoreDatabase.js --file <dump> --target-db <banco-destino>');
  }

  const conn = resolveConnection();
  const mainDbName = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '') : process.env.DB_NAME;

  if (targetDb === mainDbName) {
    throw new Error(
      `Recusado: --target-db "${targetDb}" é igual ao banco principal configurado no ambiente. ` +
      'Restore de teste exige um banco de destino DIFERENTE (descartável), nunca o banco principal.'
    );
  }

  const args = [
    '--clean', '--if-exists',
    '-h', conn.host,
    '-p', String(conn.port),
    '-U', conn.user,
    '-d', targetDb,
    '--no-password',
    file,
  ];

  await new Promise((resolve, reject) => {
    execFile(resolveBinary('pg_restore'), args, { env: { ...process.env, PGPASSWORD: conn.password } }, (error, stdout, stderr) => {
      // pg_restore devolve exit code != 0 em warnings não-fatais (ex. objeto já não existe pro
      // --if-exists apagar) — por isso checamos a mensagem, não só o exit code.
      if (error && !/already exists|does not exist/i.test(stderr || '')) {
        reject(new Error(`pg_restore falhou: ${stderr || error.message}`));
        return;
      }
      resolve();
    });
  });

  console.log(`Restore concluído em "${targetDb}" a partir de ${file}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
