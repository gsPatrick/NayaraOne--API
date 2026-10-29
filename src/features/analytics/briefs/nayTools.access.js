'use strict';

/**
 * M9-D695 — acesso comum das ferramentas da NAY Diretoria. Cada ferramenta roda com as permissões do USUÁRIO que pediu (ou do papel do
 * destinatário do briefing) e passa pelo MESMO caminho de saída do BI (M9-D700): permissão do BI, permissão do domínio da métrica, escopo
 * da empresa (RLS), mascaramento de RESTRICTED e linha NAY_QUERY no log de acesso. Falta de permissão vira 403
 * ANALYTICS_DRILLDOWN_FORBIDDEN com blockedReason PERMISSION: o executor grava a chamada como BLOCKED e ela conta em ai.tool_calls_blocked.
 */
const AppError = require('../../../utils/AppError');
const { prepareSecureRows, assertPermission, assertDomainAccess, loadDomainMap, domainPermissionOf, has, P } = require('../security');
const { resolveCompanyScope } = require('../security/scope');

const forbidden = (permission) => AppError.forbidden('Você não tem permissão para ver este dado.', 'ANALYTICS_DRILLDOWN_FORBIDDEN', { blockedReason: 'PERMISSION', ...(permission ? { permission } : {}) });

/** Contexto do BI: empresa e grupo do servidor, permissões do usuário (todas as dele, não só as da tool) e o usuário no log. */
function biContext(scope) {
  return {
    groupId: scope.groupId, companyId: scope.companyId, actorUserId: scope.userId || null,
    permissions: scope.userPermissions || scope.permissions || [],
  };
}

async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && err.code === 'PERMISSION_DENIED') {
      throw forbidden(err.details && err.details.permission);
    }
    throw err;
  }
}

const assertBiRead = (ctx) => guarded(async () => assertPermission(ctx, P.READ));
const assertDomain = (ctx, domain, transaction) => guarded(() => assertDomainAccess(ctx, domain, transaction));
const companyOf = (ctx, requested, transaction) => resolveCompanyScope(ctx, requested, transaction);

/** Domínios que o usuário pode ver (permissão do domínio no mapa do administrador); usado para filtrar listas sem revelar o resto. */
async function visibleDomains(ctx, domains, transaction) {
  const map = await loadDomainMap(ctx, transaction);
  return new Set([...new Set(domains.filter(Boolean))].filter((d) => has(ctx, domainPermissionOf(map, d))));
}

/** Saída com mascaramento de RESTRICTED e linha NAY_QUERY no log. Devolve a lista de linhas já mascarada. */
function secureRows(ctx, { tool, resourceCode, domain, filters, rows }, transaction) {
  // Instantes viram texto ISO antes do mascaramento (o mascaramento percorre objetos e não preserva Date).
  const plain = JSON.parse(JSON.stringify(rows));
  return guarded(() => prepareSecureRows(ctx, {
    permission: P.READ, domain: domain || null, action: 'NAY_QUERY', resourceType: 'NAY_TOOL', resourceCode: resourceCode || tool,
    route: `nay:${tool}`, filters: { tool, ...(filters || {}) }, rows: plain, transaction,
  })).then((r) => r.rows);
}

module.exports = { biContext, assertBiRead, assertDomain, companyOf, visibleDomains, secureRows, forbidden };
