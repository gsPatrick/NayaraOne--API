'use strict';

const { getSetting } = require('../../settings/settings.service');
const { getEffectiveAccess } = require('../../memberships/effectivePermissions.service');
const settings = require('./dlp.settings');
const { resolveClassification } = require('./classification.resolver');
const { readSuspension } = require('./suspension.reader');
const policyService = require('./policy.service');

const read = (key, tenant, transaction) => getSetting(key, tenant, transaction, settings.DLP_SETTING_DEFAULTS[key]);

/**
 * Tudo que o guard puro precisa, lido na transação da decisão: a classificação MAIS ALTA do pedido (etapa 1), a política da empresa para (classe, ação), as
 * permissões efetivas do usuário (as do pedido, ou as da empresa quando o chamador não as passou), a suspensão por anomalia (só para as ações que ela cobre), o
 * catálogo de finalidades e o mínimo da justificativa (parâmetros governanca.dlp.*).
 */
async function buildContext(tenant, req, transaction) {
  const classification = await resolveClassification(tenant, req.resources, transaction);
  const policy = await policyService.getPolicy(tenant, classification, req.action, transaction);
  const permissions = req.permissions || (await getEffectiveAccess(req.actorUserId, tenant.companyId, transaction)).permissions;
  const suspendable = ['EXPORT', 'SHARE', 'PRINT'].includes(req.action);
  return {
    classification,
    policy,
    permissions,
    suspendedUntil: suspendable ? await readSuspension(tenant, req.actorUserId, transaction) : null,
    now: new Date(),
    purposes: settings.parsePurposes(await read(settings.PURPOSES_KEY, tenant, transaction)),
    justificationMin: settings.parseJustificationMin(await read(settings.JUSTIFICATION_MIN_KEY, tenant, transaction)),
  };
}

module.exports = { buildContext };
