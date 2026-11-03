'use strict';

/**
 * Roda um comando qualquer contra um banco PostgreSQL local DESCARTÁVEL, preparado como o CI
 * (migrations do zero + seeds + role de runtime NOSUPERUSER/NOBYPASSRLS). Ao final o cluster é
 * parado e o diretório apagado. Serve para os testes que COMMITAM dados (HTTP real, failure
 * drills, carga) não gravarem nada no banco compartilhado.
 *
 * Uso:
 *   node scripts/withDisposableDb.js [--port 5462] -- <comando> [args...]
 *   ex.: node scripts/withDisposableDb.js -- node --test --test-concurrency=1 test/inventory.failureDrills.test.js
 *
 * O processo filho recebe DATABASE_URL (role de runtime), DATABASE_ADMIN_URL (superusuário do
 * cluster, só para setup/limpeza de carga), DB_MIGRATION_USER/PASSWORD e chaves temporárias.
 */

const cluster = require('./lib/disposableCluster');

async function main() {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf('--');
  if (sep === -1 || sep === argv.length - 1) {
    console.error('Uso: node scripts/withDisposableDb.js [--port N] -- <comando> [args...]');
    process.exit(2);
  }
  const own = argv.slice(0, sep);
  const cmd = argv.slice(sep + 1);
  const port = Number(own.includes('--port') ? own[own.indexOf('--port') + 1] : 0) || Number(process.env.DRILL_PG_PORT) || 5462;

  const started = Date.now();
  const db = cluster.prepareDatabase({ port, db: 'drill_app', label: 'app' });
  console.log(`[withDisposableDb] cluster descartável 127.0.0.1:${port}/drill_app pronto (${db.migrated} migrations, GRANT em ${db.schemaCount} schemas) em ${((Date.now() - started) / 1000).toFixed(1)} s`);
  let status = 1;
  try {
    const env = db.childEnv({
      DATABASE_URL: db.appUrl,
      DATABASE_ADMIN_URL: db.superUrl,
      DB_MIGRATION_USER: cluster.SUPER,
      DB_MIGRATION_PASSWORD: 'trust-local',
      DISPOSABLE_DB: '1',
    });
    const res = cluster.run(cmd[0], cmd.slice(1), env, { inherit: true });
    status = res.status;
  } finally {
    db.stop();
    console.log('[withDisposableDb] cluster parado e diretório temporário apagado.');
  }
  process.exit(status);
}

main().catch((err) => {
  console.error(`[withDisposableDb] ${err.message}`);
  process.exit(1);
});
