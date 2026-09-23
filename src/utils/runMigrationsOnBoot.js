'use strict';

const { execFileSync } = require('child_process');
const logger = require('./logger');

/**
 * Roda `sequelize-cli db:migrate` automaticamente na subida do processo, ANTES do app começar
 * a aceitar requisições — resolve a dor operacional de "esqueci de rodar a migration antes do
 * deploy" (aconteceu na prática em 23/09/2026: migration 176 ficou pendente após o deploy do
 * código porque o passo de migrate é manual).
 *
 * Opt-in via RUN_MIGRATIONS_ON_BOOT=true — nunca liga sozinho, porque a conexão padrão da
 * aplicação (`DATABASE_URL`) usa o papel `nayara_runtime`, de privilégio mínimo e SEM permissão
 * de DDL (CREATE INDEX, ALTER TABLE etc. falham); só migrations puramente DML (INSERT/UPDATE
 * simples) passariam por ele. Para migrations com DDL, configure `MIGRATIONS_DATABASE_URL` com
 * uma connection string de um usuário com privilégio de DDL (o mesmo usado manualmente até
 * hoje) — se não for definida, cai para `DATABASE_URL` mesmo (só funciona para migrations DML).
 *
 * Nunca derruba o boot do processo: se a migration falhar (ex.: falta de permissão, migration
 * já aplicada por outro processo em paralelo), loga o erro e deixa o app subir do mesmo jeito —
 * preferível a um serviço inteiro fora do ar por causa de uma migration que já rodou ou de uma
 * corrida com outro pod subindo ao mesmo tempo.
 */
function runMigrationsOnBoot() {
  if (process.env.RUN_MIGRATIONS_ON_BOOT !== 'true') return;

  const migrationsDatabaseUrl = process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL;
  if (!migrationsDatabaseUrl) {
    logger.warn('[runMigrationsOnBoot] RUN_MIGRATIONS_ON_BOOT=true mas nenhuma DATABASE_URL/MIGRATIONS_DATABASE_URL definida — pulando.');
    return;
  }

  try {
    logger.info('[runMigrationsOnBoot] Rodando migrations pendentes antes de subir o servidor...');
    const output = execFileSync('npx', ['sequelize-cli', 'db:migrate'], {
      env: { ...process.env, DATABASE_URL: migrationsDatabaseUrl },
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 120000,
    });
    logger.info({ output: output.trim() }, '[runMigrationsOnBoot] Migrations aplicadas com sucesso.');
  } catch (err) {
    logger.error(
      { error: err.message, stdout: err.stdout?.toString?.(), stderr: err.stderr?.toString?.() },
      '[runMigrationsOnBoot] Falha ao rodar migrations automaticamente — subindo o servidor mesmo assim. Rode `npm run migrate` manualmente com um usuário com privilégio de DDL.'
    );
  }
}

module.exports = { runMigrationsOnBoot };
