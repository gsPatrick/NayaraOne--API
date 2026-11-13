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
 */
const SUPPORT_ROLES = [
  { name: 'nayara_migration', sql: 'CREATE ROLE nayara_migration' },
  { name: 'nayara_analytics_reader', sql: 'CREATE ROLE nayara_analytics_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION' },
];

function createSupportRoles(psql, port) {
  for (const role of SUPPORT_ROLES) psql(port, 'postgres', role.sql);
  return SUPPORT_ROLES.map((r) => r.name);
}

module.exports = { SUPPORT_ROLES, createSupportRoles };
