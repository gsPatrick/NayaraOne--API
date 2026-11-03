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
const { resolveDumpConnection, resolveBinary } = require('./backupDatabase');

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

  // GAP REAL CORRIGIDO (drill de restore/replay Financeiro/Jurídico, 16/10/2026): pg_restore
  // precisa CRIAR schemas (finance, legal, core, etc.) no banco de destino recém-criado — a
  // credencial de runtime não é dona desse banco e não tem privilégio CREATE nele, então toda
  // CREATE SCHEMA falhava com "permission denied" e o restore terminava "com sucesso" sem
  // nenhum dado de verdade (ver fix do bug de detecção de erro abaixo — a checagem antiga nunca
  // pegava isso). Usa a mesma credencial de DDL com BYPASSRLS/privilégio de criação que o
  // backup já usa (resolveDumpConnection em backupDatabase.js).
  const conn = resolveDumpConnection();
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
    execFile(
      resolveBinary('pg_restore'),
      args,
      { env: { ...process.env, PGPASSWORD: conn.password }, maxBuffer: 50 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // GAP REAL CORRIGIDO (16/10/2026): a checagem antiga só olhava pro objeto `error` (que o
        // pg_restore pode deixar nulo/exit-0 mesmo com dezenas de comandos individuais
        // falhando — cada objeto é uma query separada dentro do dump) e, quando havia erro,
        // tratava QUALQUER stderr contendo "does not exist" como inofensivo — um regex largo
        // demais que escondeu "permission denied for database X" só porque a mensagem seguinte
        // em cascata (ALTER SCHEMA ... OWNER TO — depois que o CREATE SCHEMA já tinha falhado)
        // também continha a frase "does not exist". Resultado real observado: restore
        // "concluído com sucesso" sem nenhum schema/tabela criado. Agora falha sempre que o
        // stderr contém "permission denied" (nunca é um aviso inofensivo de --clean/--if-exists
        // num banco novo vazio) — e só ignora o padrão específico e esperado de limpeza em
        // banco vazio (objeto que --if-exists tentou derrubar e não existia).
        const stderrText = stderr || '';
        // GAP REAL CORRIGIDO (drill F05, 18/10/2026): restaurar num cluster NOVO, onde a role de
        // runtime ainda não existe, gera `role "nayara_runtime" does not exist` em cada GRANT —
        // e o filtro abaixo ("does not exist" = aviso inofensivo de --clean num banco vazio)
        // engolia isso. O restore terminava "com sucesso", mas sem nenhum privilégio para a
        // aplicação: a API restaurada não conseguiria ler nada. Role ausente é sempre falha,
        // com a instrução de criar as roles antes (ver runbook de restore).
        const missingRoles = [...new Set([...stderrText.matchAll(/role "([^"]+)" does not exist/gi)].map((m) => m[1]))];
        if (missingRoles.length > 0) {
          reject(new Error(
            `pg_restore falhou: role(s) ausente(s) no servidor de destino: ${missingRoles.join(', ')}. ` +
            'Crie as roles antes do restore — nayara_runtime (LOGIN, NOSUPERUSER, NOBYPASSRLS) e nayara_migration (NOLOGIN) — ' +
            'e refaça o restore num banco de destino vazio.'
          ));
          return;
        }
        const hasPermissionDenied = /permission denied/i.test(stderrText);
        const hasUnexpectedError = error && !/already exists|does not exist/i.test(stderrText);
        if (hasPermissionDenied || hasUnexpectedError) {
          reject(new Error(`pg_restore falhou:\n${stderrText || (error && error.message) || '(sem stderr)'}`));
          return;
        }
        resolve();
      }
    );
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
