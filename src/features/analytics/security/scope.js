'use strict';

/**
 * M9-D700 (4) — empresa pedida (`companyId` de uma consulta de BI): vale a empresa da sessão; qualquer outra precisa existir
 * visível para a sessão (RLS) e ser do mesmo grupo. Empresa de outro grupo, inexistente ou sem vínculo: 404
 * ANALYTICS_SCOPE_NOT_FOUND (nunca 403, não revela existência). Empresa do mesmo grupo e visível, mas diferente da sessão:
 * 400 ANALYTICS_SCOPE_SWITCH_REQUIRED (o BI lê pela empresa da sessão; troque de empresa para consultá-la).
 */
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => AppError.notFound('Empresa não encontrada ou sem acesso.', 'ANALYTICS_SCOPE_NOT_FOUND');

async function resolveCompanyScope(ctx, requestedCompanyId, transaction) {
  if (requestedCompanyId === undefined || requestedCompanyId === null || requestedCompanyId === '' || requestedCompanyId === ctx.companyId) {
    return ctx.companyId;
  }
  if (typeof requestedCompanyId !== 'string' || !UUID_RE.test(requestedCompanyId)) throw notFound();
  const [rows] = await sequelize.query(
    'SELECT id FROM core.companies WHERE id = :id AND group_id = :groupId AND deleted_at IS NULL',
    { replacements: { id: requestedCompanyId, groupId: ctx.groupId }, transaction }
  );
  if (!rows[0]) throw notFound();
  throw AppError.badRequest('Para consultar outra empresa, troque de empresa na sessão.', 'ANALYTICS_SCOPE_SWITCH_REQUIRED');
}

module.exports = { resolveCompanyScope };
