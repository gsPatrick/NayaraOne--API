'use strict';

// Apoio dos testes M9-D820 e M9-D821 (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const { QueryTypes } = require('sequelize');
const base = require('./m9d803Env');
const { adminQuery } = require('../../m9d801.helpers');

const { sequelize } = base;
const actorOf = (tenant) => ({ userId: tenant.userId, roles: ['ADMIN'] });
const codeOf = async (promise) => promise.then(() => null, (err) => ({ code: err.code, status: err.statusCode, message: err.message, details: err.details }));
const rows = (sql, replacements, tx) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction: tx, replacements });

/** Auditorias de uma ação da empresa, da mais nova para a mais antiga. */
const auditRows = (tenant, action, tx) => rows('SELECT * FROM audit.audit_log WHERE company_id = :companyId AND action = :action ORDER BY occurred_at DESC', { companyId: tenant.companyId, action }, tx);

/** Dá (ou tira) uma permissão de governança a um perfil de CI, nas duas empresas. */
async function setRolePermission(roleName, code, granted) {
  await adminQuery('DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = $1 AND p.code = $2', [roleName, code]);
  if (!granted) return;
  await adminQuery(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
    SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p WHERE r.name = $1 AND p.code = $2`, [roleName, code]);
}

/** Remove a política e os pedidos das duas empresas (os testes que usam commit real limpam o que criaram). */
async function cleanDlp() {
  await adminQuery('DELETE FROM governance.dlp_policies');
}

module.exports = { ...base, actorOf, codeOf, rows, auditRows, setRolePermission, cleanDlp, adminQuery, sequelize };
