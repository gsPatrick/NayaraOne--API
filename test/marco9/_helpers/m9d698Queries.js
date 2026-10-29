'use strict';

// Apoio da M9-D698: captura o SQL de TODAS as consultas do Sequelize enquanto uma função roda e separa as que tocam tabelas de OUTROS schemas
// (as tabelas de origem: finance, real_estate, crm...). Configuração do BI (core.tenant_settings, core.permissions) e o schema analytics são permitidos.
const { sequelize } = require('../../testHelpers');

const ALLOWED = new Set(['analytics', 'core', 'pg_catalog', 'information_schema']);

async function sourceSchemas(admin) {
  const [rows] = await admin.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'");
  return rows.map((r) => r.nspname).filter((n) => !ALLOWED.has(n));
}

/** Roda fn e devolve { sql: [todas as consultas], sources: [as que citam tabela de origem] }. */
async function capture(admin, fn) {
  const schemas = await sourceSchemas(admin);
  const re = new RegExp(`(?:^|[^a-z0-9_."])"?(${schemas.join('|')})"?\\."?([a-z_][a-z0-9_]*)"?`, 'i');
  const sql = [];
  const previous = sequelize.options.logging;
  sequelize.options.logging = (text) => { sql.push(String(text)); };
  try {
    await fn();
  } finally {
    sequelize.options.logging = previous;
  }
  return { sql, sources: sql.filter((q) => re.test(q)) };
}

module.exports = { capture, sourceSchemas };
