'use strict';

/**
 * Roles de apoio que o dump referencia e que um cluster de destino NOVO não tem.
 * Procedimento do runbook de restore: criar estas roles (além da role de runtime) ANTES do
 * pg_restore. Sem elas o restore falha apontando a role ausente.
 *
 *   nayara_migration        — dona dos objetos / default privileges (migration 336), NOLOGIN.
 *   nayara_analytics_reader — leitor somente leitura do BI do Marco 9 (migration 9612), NOLOGIN.
 *
 * Achado do drill de 10/11/2026: o drill jurídico e o de estoque só criavam nayara_migration;
 * depois da migration 9612 o restore passou a falhar com "role nayara_analytics_reader ausente".
 *
 * Achado do drill de Obras de 11/11/2026 (esteira de qualidade do Marco 6): o pg_dump de um banco NÃO leva a pertença de
 * papéis (é global do cluster). Na origem a migration 9612 faz `GRANT nayara_analytics_reader TO nayara_runtime`; num
 * servidor novo, sem este passo, o runtime não consegue assumir o papel do BI (readOnly.readerRole.js: pg_has_role falso) e
 * os GET de /analytics perdem, em silêncio, uma das duas camadas contra escrita. O procedimento passa a refazer a pertença
 * (só se o runtime já existir; idempotente).
 */
const SUPPORT_ROLES = [
  { name: 'nayara_migration', sql: 'CREATE ROLE nayara_migration' },
  { name: 'nayara_analytics_reader', sql: 'CREATE ROLE nayara_analytics_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION' },
];

const MEMBERSHIP_SQL = `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN GRANT nayara_analytics_reader TO nayara_runtime; END IF; END $$`;

function createSupportRoles(psql, port) {
  for (const role of SUPPORT_ROLES) psql(port, 'postgres', role.sql);
  psql(port, 'postgres', MEMBERSHIP_SQL);
  return SUPPORT_ROLES.map((r) => r.name);
}

module.exports = { SUPPORT_ROLES, MEMBERSHIP_SQL, createSupportRoles };
