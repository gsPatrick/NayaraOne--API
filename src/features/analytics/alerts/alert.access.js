'use strict';

/**
 * M9-D703 (3.1 e 3.2) — quem vê e quem reconhece. ABAC por domínio da métrica: o alerta de uma métrica cujo domínio o usuário não lê (permissão do módulo
 * de origem, mapa `analytics.abac.mapa_dominio_permissao`) NÃO aparece na lista, não entra no total e responde 404 no ack. Reconhecer exige ser o responsável
 * (o usuário owner ou membro ATIVO do papel owner, incluindo o papel reserva do owner removido) ou ter `analytics:alert:manage`.
 */
const AppError = require('../../../utils/AppError');
const { has } = require('../security/permissionGuard');
const { loadDomainMap, domainPermissionOf } = require('../security/abac');
const { P } = require('../security/permissionCatalog');
const { resolveOwnerRecipients } = require('./owner.resolve');
const { readAlertParams } = require('./engine.settings');

const DOMAINS = Object.freeze(['GENERAL', 'FINANCE', 'CRM', 'PROPERTIES', 'RENTAL', 'CONSTRUCTION', 'INVENTORY', 'LEGAL', 'CORRESPONDENT', 'MARKETING', 'SUPPORT', 'TECH_AI']);

/** Domínios (incluindo GENERAL, dos painéis de comando) que o usuário pode ler. */
async function readableDomains(ctx, transaction) {
  const map = await loadDomainMap(ctx, transaction);
  return DOMAINS.filter((domain) => has(ctx, domainPermissionOf(map, domain)));
}

const notFound = () => AppError.notFound('Alerta não encontrado.', 'ANALYTICS_ALERT_NOT_FOUND');

/** 403 ANALYTICS_ALERT_NOT_OWNER quando o usuário não é o responsável e não tem analytics:alert:manage. */
async function assertMayAcknowledge(ctx, row, transaction) {
  if (has(ctx, P.ALERT_MANAGE)) return;
  const scope = { companyId: row.company_id, groupId: row.group_id };
  const params = await readAlertParams(scope, transaction);
  const owners = await resolveOwnerRecipients({ owner_user_id: row.owner_user_id, owner_role: row.owner_role }, scope, params, transaction);
  if (!owners.userIds.includes(ctx.actorUserId)) {
    throw AppError.forbidden('Somente o responsável pelo alerta pode reconhecê-lo.', 'ANALYTICS_ALERT_NOT_OWNER');
  }
}

module.exports = { readableDomains, assertMayAcknowledge, notFound, DOMAINS };
