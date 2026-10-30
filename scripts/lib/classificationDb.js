'use strict';

const { Client } = require('pg');

/**
 * Conexão dos scripts de classificação (M9-D910): SÓ em banco local. Lê DATABASE_ADMIN_URL (ou DATABASE_URL) do ambiente, nunca do .env, e recusa qualquer host
 * que não seja 127.0.0.1/localhost, para nunca tocar a homologação por engano (use scripts/withDisposableDb.js).
 */
function connectionString() {
  const url = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Defina DATABASE_ADMIN_URL ou DATABASE_URL de um banco LOCAL (node scripts/withDisposableDb.js -- <comando>).');
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw new Error('Recusado: o script só roda em banco local (host 127.0.0.1). Use scripts/withDisposableDb.js.');
  return url;
}

async function withClient(work) {
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  try { return await work(client); } finally { await client.end(); }
}

module.exports = { withClient };
