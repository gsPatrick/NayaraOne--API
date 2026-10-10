'use strict';

/**
 * GAP REAL CORRIGIDO (auditoria Marco 6, 08/10/2026 — "restore reproduzível" exigido no PDF da
 * Nayara, cláusula 12ª do contrato "BACKUP, RESTORE E OBSERVABILIDADE"): não existia nenhum
 * script de backup/restore no repositório. Este script gera um dump real via pg_dump (formato
 * custom, -Fc — permite restore seletivo por schema/tabela e é o formato recomendado pelo
 * Postgres para bancos de produção).
 *
 * Uso: node scripts/backupDatabase.js [--out <diretorio>]
 * Lê as mesmas variáveis de ambiente que o resto do projeto (DATABASE_URL, ou DB_HOST/DB_PORT/
 * DB_NAME/DB_USER/DB_PASSWORD — ver .env.example). Nunca interpola a senha na linha de comando
 * (usa PGPASSWORD como variável de ambiente do processo filho, nunca argv) — mesma proteção
 * contra vazamento de credencial em `ps`/logs que o resto do projeto já segue.
 */

require('dotenv').config();
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

// GAP REAL CORRIGIDO (restore reproduzível, 08/10/2026): o pg_dump do Homebrew (keg-only por
// padrão) costuma ficar numa versão major mais antiga que o Postgres gerenciado (ex. produção
// em Postgres 17, Homebrew com postgresql@16 instalado por outra dependência) — pg_dump recusa
// rodar contra um servidor de versão MAIOR que a dele ("aborting because of server version
// mismatch"). Resolve o binário mais recente disponível entre os kegs do Homebrew antes de cair
// pro `pg_dump`/`pg_restore` genérico do PATH.
function resolveBinary(name) {
  const candidates = [
    `/opt/homebrew/opt/postgresql@17/bin/${name}`,
    `/opt/homebrew/opt/postgresql@16/bin/${name}`,
    name,
  ];
  for (const candidate of candidates) {
    if (candidate === name) return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return name;
}

function resolveConnection() {
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    return {
      host: u.hostname,
      port: u.port || '5432',
      database: u.pathname.replace(/^\//, ''),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
  }
  return {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || '5432',
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  };
}

function parseArgs(argv) {
  const out = { outDir: path.join(__dirname, '..', 'backups') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) {
      out.outDir = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

async function main() {
  const conn = resolveConnection();
  if (!conn.host || !conn.database || !conn.user) {
    throw new Error('Configuração de banco incompleta — defina DATABASE_URL ou DB_HOST/DB_NAME/DB_USER no ambiente.');
  }

  const { outDir } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(outDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${conn.database}_${timestamp}.dump`);

  const args = [
    '-Fc',
    '-h', conn.host,
    '-p', String(conn.port),
    '-U', conn.user,
    '-d', conn.database,
    '-f', outFile,
    '--no-password',
  ];

  await new Promise((resolve, reject) => {
    execFile(resolveBinary('pg_dump'), args, { env: { ...process.env, PGPASSWORD: conn.password } }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`pg_dump falhou: ${stderr || error.message}`));
        return;
      }
      resolve();
    });
  });

  const stats = fs.statSync(outFile);
  console.log(`Backup gerado com sucesso: ${outFile} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
  return outFile;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { main, resolveConnection, resolveBinary };
