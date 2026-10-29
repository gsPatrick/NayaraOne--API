'use strict';

/**
 * M9-D701 (3.1 passos 1 e 2 e 3.3) — permissão e escopo da exportação, na ordem do livro: (1) `analytics:export` e a permissão do domínio do alvo;
 * (2) escopo: a empresa (ou o grupo) é a da sessão, senão 404 ANALYTICS_SCOPE_NOT_FOUND (nunca 403); o consolidado do grupo exige `analytics:read:group`.
 * O MESMO conjunto de verificações roda no pedido e, de novo, no worker com as permissões de agora do solicitante (ANALYTICS_EXPORT_PERMISSION_REVOKED).
 */
const AppError = require('../../../utils/AppError');
const { P, assertPermission, assertDomainAccess } = require('../security');
const { findDefinition } = require('../metrics/registry.read');
const readStore = require('../dashboardReadStore.service');
const { scopeNotFound } = require('./export.errors');

function assertScope(ctx, plan) {
  if (plan.level === 'GROUP') {
    if (plan.groupId !== ctx.groupId) throw scopeNotFound();
    assertPermission(ctx, P.READ_GROUP);
    return;
  }
  if (plan.companyId !== undefined && plan.companyId !== ctx.companyId) throw scopeNotFound();
}

/** Devolve { domain, name, dashboard? } do alvo, depois de conferir permissão, escopo e domínio. */
async function assertExportAccess(ctx, plan, transaction) {
  assertPermission(ctx, P.EXPORT);
  assertScope(ctx, plan);
  assertPermission(ctx, P.READ);
  if (plan.kind === 'DASHBOARD') {
    const dash = await readStore.findPublishedDashboard({ code: plan.code, companyId: ctx.companyId, groupId: ctx.groupId }, transaction);
    if (!dash) throw AppError.notFound('Painel não encontrado.', 'ANALYTICS_DASHBOARD_NOT_FOUND');
    assertPermission(ctx, dash.required_permission);
    await assertDomainAccess(ctx, dash.domain, transaction);
    return { domain: dash.domain, name: dash.name, dashboard: dash };
  }
  const definition = await findDefinition(plan.code, transaction);
  await assertDomainAccess(ctx, definition.domain, transaction);
  return { domain: definition.domain, name: definition.name, definition };
}

module.exports = { assertExportAccess };
