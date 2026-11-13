'use strict';

/**
 * M9-D625 (3.1 e 6) — escopo do consolidado: o grupo pedido tem de ser o da sessão (senão 404, sem revelar existência), o usuário precisa de
 * `analytics:read:group` (senão 403 ANALYTICS_GROUP_SCOPE_FORBIDDEN) e o consolidado agrega SÓ as empresas do grupo a que o usuário tem acesso: vínculo
 * ativo com papel que dá `analytics:read` e a permissão da área do indicador (ABAC da M9-D700). A empresa da sessão vale pelas permissões do token;
 * as demais pelo vínculo do usuário com a empresa, lido sob o contexto de RLS dela (a empresa da sessão é restaurada ao fim).
 */
const { sequelize } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { P, has, loadDomainMap, domainPermissionOf } = require('../../security');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () => AppError.notFound('Grupo não encontrado ou sem acesso.', 'ANALYTICS_SCOPE_NOT_FOUND');
const forbidden = () => AppError.forbidden('Você não tem permissão para ver o consolidado do grupo.', 'ANALYTICS_GROUP_SCOPE_FORBIDDEN', { permission: P.READ_GROUP });

/** Executa `fn` com a empresa `companyId` no contexto de RLS da transação e restaura a empresa da sessão. */
async function inCompany(companyId, restoreCompanyId, transaction, fn) {
  const set = (id) => sequelize.query("SELECT set_config('app.company_id', :id, true)", { replacements: { id }, transaction });
  if (companyId === restoreCompanyId) return fn();
  await set(companyId);
  try {
    return await fn();
  } finally {
    await set(restoreCompanyId);
  }
}

function assertGroupScope(ctx, requestedGroupId) {
  if (typeof requestedGroupId !== 'string' || !UUID_RE.test(requestedGroupId) || requestedGroupId.toLowerCase() !== String(ctx.groupId).toLowerCase()) throw notFound();
  if (!has(ctx, P.READ_GROUP)) throw forbidden();
}

/** Permissões do usuário na empresa (vínculo ativo e papel não apagado), lidas por consulta somente leitura sob o contexto de RLS da empresa. */
async function membershipPermissions(userId, companyId, transaction) {
  const [rows] = await sequelize.query(
    `SELECT DISTINCT p.code FROM core.user_memberships m JOIN core.roles r ON r.id = m.role_id AND r.deleted_at IS NULL
       JOIN core.role_permissions rp ON rp.role_id = r.id JOIN core.permissions p ON p.id = rp.permission_id
      WHERE m.user_id = :userId AND m.company_id = :companyId AND m.status = 'ACTIVE' AND m.deleted_at IS NULL`,
    { replacements: { userId, companyId }, transaction }
  );
  return rows.map((r) => r.code);
}

/** [{ id, name }] das empresas ativas do grupo. */
async function listGroupCompanies(groupId, transaction) {
  const [rows] = await sequelize.query('SELECT id, name FROM core.companies WHERE group_id = :groupId AND deleted_at IS NULL ORDER BY name, id', { replacements: { groupId }, transaction });
  return rows;
}

/**
 * Empresas que o usuário alcança para o indicador: [{ id, name, permissions }] (as permissões efetivas nela) e quantas o grupo tem.
 * `domain` = domínio da métrica (a permissão de leitura da área vem do mapa do administrador).
 */
async function permittedCompanies(ctx, domain, transaction) {
  const companies = await listGroupCompanies(ctx.groupId, transaction);
  const need = domainPermissionOf(await loadDomainMap(ctx, transaction), domain);
  const allowed = [];
  for (const company of companies) {
    const permissions = company.id === ctx.companyId
      ? [...ctx.permissions]
      : await inCompany(company.id, ctx.companyId, transaction, () => membershipPermissions(ctx.actorUserId, company.id, transaction));
    if ((permissions.includes(P.READ) || permissions.includes(P.MANAGE)) && permissions.includes(need)) allowed.push({ ...company, permissions });
  }
  return { allowed, total: companies.length };
}

module.exports = { assertGroupScope, permittedCompanies, inCompany, listGroupCompanies, membershipPermissions };
