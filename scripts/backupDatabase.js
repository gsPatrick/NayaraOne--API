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
// GAP REAL CORRIGIDO (drill de restore/replay Financeiro/Jurídico, 16/10/2026): além do problema
// de SequelizeMeta acima, pg_dump de um banco INTEIRO também esbarra em RLS fail-closed — a
// maioria das tabelas de negócio (finance.*, legal.*, ai.* etc.) tem policy de tenant_isolation
// que depende de current_setting('app.group_id'/'app.company_id'), que pg_dump nunca define (ele
// faz um único COPY por tabela, sem contexto de tenant). A role de runtime (nayara_runtime) não
// tem BYPASSRLS — por design, nunca deveria ter. A credencial de DDL dedicada
// (DB_MIGRATION_USER/PASSWORD, de .env.migration.local — mesma usada por `npm run migrate --env
// migration`) tem BYPASSRLS, exatamente para operações administrativas como esta. Carregada aqui
// do mesmo jeito que src/config/sequelize-cli.js já faz.
require('dotenv').config({ path: require('node:path').resolve(process.cwd(), '.env.migration.local') });
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

// IMPORTANTE: esta função é exportada e reaproveitada por restoreDatabase.js e pelos scripts
// verifyRestore*.js — eles dependem de abrir conexão com a credencial de RUNTIME (sem
// BYPASSRLS) para que os `SET LOCAL app.group_id/app.company_id` que já fazem tenham efeito de
// verdade (RLS fail-closed real, não um no-op). NÃO troque a credencial usada aqui — ver
// resolveDumpConnection() abaixo para a credencial elevada, usada só no pg_dump deste arquivo.
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

/**
 * resolveDumpConnection — ver comentário no topo do arquivo: pg_dump precisa de BYPASSRLS
 * (não tem como fazer SET LOCAL por tabela durante um COPY). Usado SÓ internamente neste
 * arquivo, para o processo pg_dump em si — nunca exportado, nunca usado pelos scripts de
 * restore/verificação, que precisam continuar enxergando RLS de verdade.
 */
function resolveDumpConnection() {
  const base = resolveConnection();
  if (process.env.DB_MIGRATION_USER && process.env.DB_MIGRATION_PASSWORD) {
    return { ...base, user: process.env.DB_MIGRATION_USER, password: process.env.DB_MIGRATION_PASSWORD };
  }
  return base;
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
  const conn = resolveDumpConnection();
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
    // GAP REAL CORRIGIDO (drill de restore/replay Financeiro/Jurídico, 16/10/2026): a role de
    // runtime (nayara_runtime) não tem permissão de LOCK/SELECT em public."SequelizeMeta"
    // (tabela de controle interno do sequelize-cli, dona por outra role — nunca foi incluída
    // nos GRANTs de schema aplicados a nayara_runtime, só tabelas de negócio o foram). pg_dump
    // falha com "permission denied for table SequelizeMeta" antes mesmo de começar o dump real,
    // porque tenta LOCK TABLE em TODAS as tabelas do banco por padrão. Excluir essa única tabela
    // de bookkeeping (não é dado de negócio, nunca precisa ser restaurada — o banco de destino
    // roda suas próprias migrations do zero quando precisar de histórico de schema) resolve sem
    // precisar elevar privilégio da role de runtime só para backup.
    '--exclude-table=public."SequelizeMeta"',
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

module.exports = { main, resolveConnection, resolveDumpConnection, resolveBinary };
