'use strict';

/**
 * Concede à role de runtime (nayara_runtime, NOSUPERUSER/NOBYPASSRLS) as permissões mínimas por schema, como o CI
 * faz, e REAPLICA os revokes de append-only das migrations (audit_log, histórico de status, roteamento, comissão,
 * fiscal). As migrations só dão GRANT/REVOKE quando a role já existe no momento em que rodam: num banco em que a role
 * foi criada depois (ou nunca recebeu permissão) a API conecta e toda consulta falha com "permission denied for
 * schema core" (login devolve "Erro interno do servidor"). Este script conserta esse estado e pode rodar de novo
 * sem efeito colateral.
 *
 * Uso (credencial de DDL de .env.migration.local; só mostra o que fará com --simular):
 *   node scripts/aplicarPermissoesRuntime.js [--simular]
 *
 * Desfazer: REVOKE ALL ON ALL TABLES/SEQUENCES IN SCHEMA <schema> FROM nayara_runtime; REVOKE USAGE ON SCHEMA <schema> ...
 */

require('dotenv').config();
require('dotenv').config({ path: '.env.migration.local' });
const { Client } = require('pg');

const ROLE = 'nayara_runtime';
const SIMULAR = process.argv.includes('--simular');

// Mesmos revokes das migrations 490, 640, 641, 643 e 644. TRUNCATE/TRIGGER/REFERENCES (282-284) nunca são concedidos aqui.
const REVOKES = [
  'REVOKE UPDATE, DELETE, TRUNCATE ON "audit"."audit_log" FROM %ROLE%',
  'REVOKE UPDATE, DELETE ON "correspondent"."provider_status_history" FROM %ROLE%',
  'REVOKE UPDATE, DELETE ON "correspondent"."external_case_routing" FROM %ROLE%',
  'REVOKE UPDATE, DELETE ON "correspondent"."accounting_export_lines", "correspondent"."dimob_records", "correspondent"."invoice_events" FROM %ROLE%',
  'REVOKE DELETE ON "correspondent"."commission_entitlements" FROM %ROLE%',
  'REVOKE DELETE ON "correspondent"."dimob_batches", "correspondent"."accounting_export_batches", "correspondent"."accounting_return_imports", "correspondent"."invoice_requests" FROM %ROLE%',
];

(async () => {
  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_MIGRATION_USER,
    password: process.env.DB_MIGRATION_PASSWORD,
    database: process.env.DB_NAME,
  });
  await client.connect();
  const role = await client.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [ROLE]);
  if (!role.rowCount) throw new Error(`A role ${ROLE} não existe neste banco.`);
  if (role.rows[0].rolsuper || role.rows[0].rolbypassrls) throw new Error(`${ROLE} é superusuário ou ignora RLS: não vou mexer.`);

  const schemas = (await client.query(
    "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('information_schema', 'public') ORDER BY 1"
  )).rows.map((r) => r.nspname);

  const comandos = [];
  for (const s of schemas) {
    comandos.push(`GRANT USAGE ON SCHEMA "${s}" TO ${ROLE}`);
    comandos.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${s}" TO ${ROLE}`);
    comandos.push(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${s}" TO ${ROLE}`);
  }
  for (const r of REVOKES) comandos.push(r.replace('%ROLE%', ROLE));

  if (SIMULAR) {
    console.log(`[simulação] ${comandos.length} comandos em ${schemas.length} schemas:\n${comandos.join('\n')}`);
    await client.end();
    return;
  }
  await client.query('BEGIN');
  try {
    for (const c of comandos) await client.query(c);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  const conferencia = await client.query(
    `SELECT n.nspname AS schema, has_schema_privilege($1, n.nspname, 'USAGE') AS uso
       FROM pg_namespace n WHERE n.nspname = ANY($2) ORDER BY 1`,
    [ROLE, schemas]
  );
  const semUso = conferencia.rows.filter((r) => !r.uso).map((r) => r.schema);
  const append = await client.query(
    `SELECT has_table_privilege($1, 'audit.audit_log', 'UPDATE') AS audit_update,
            has_table_privilege($1, 'audit.audit_log', 'INSERT') AS audit_insert,
            has_table_privilege($1, 'correspondent.provider_status_history', 'UPDATE') AS hist_update,
            has_table_privilege($1, 'correspondent.provider_status_history', 'INSERT') AS hist_insert,
            has_table_privilege($1, 'core.users', 'SELECT') AS users_select`,
    [ROLE]
  );
  console.log(`Permissões aplicadas em ${schemas.length} schemas (${comandos.length} comandos). Schemas sem USAGE: ${semUso.length ? semUso.join(', ') : 'nenhum'}.`);
  console.log('Conferência:', JSON.stringify(append.rows[0]));
  await client.end();
})().catch((err) => { console.error('Falhou:', err.message); process.exit(1); });
