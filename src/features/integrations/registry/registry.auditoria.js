'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { getSetting } = require('../../settings/settings.service');
const { ANTES_CRIACAO } = require('./registry.constants');

/** Visão da connection sem nenhum campo secreto (nem a referência do cofre). */
function serializeConnection(c) {
  return {
    id: c.id,
    groupId: c.groupId,
    companyId: c.companyId,
    providerCode: c.providerCode,
    environment: c.environment,
    label: c.label,
    status: c.status,
    secretRefConfigured: Boolean(c.secretRef),
    configJson: c.configJson,
    apiVersion: c.apiVersion,
    webhookChannelConfigured: Boolean(c.webhookChannel),
    policyJson: c.policyJson,
    productionReleasedAt: c.productionReleasedAt,
    productionReleasedBy: c.productionReleasedBy,
    lastSecretRotationAt: c.lastSecretRotationAt,
    secretExpiresAt: c.secretExpiresAt,
    createdBy: c.createdBy,
    updatedBy: c.updatedBy,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

async function auditar(ctx, c, antes, depois, motivo, transaction) {
  await registrarAuditoria(
    {
      groupId: ctx.groupId,
      companyId: ctx.companyId,
      actorUserId: ctx.userId || null,
      action: 'integration.connection.changed',
      entityType: 'IntegrationConnection',
      entityId: c.id,
      beforeJson: antes || { registro: ANTES_CRIACAO },
      afterJson: depois,
      reason: motivo,
    },
    transaction
  );
}

/** MFA recente para mudar conexão de PRODUÇÃO (INT-P091 e regra do projeto); configurável. */
async function exigirMfaEmProducao(environment, ctx, transaction, { system = false } = {}) {
  if (environment !== 'PRODUCTION' || system) return;
  const exige = await getSetting('integration.admin.mfa_on_prod_connection_change', ctx, transaction, true);
  if (exige === false) return;
  const { assertRecentMfa } = require('../../users/mfa.service');
  await assertRecentMfa(ctx.userId, transaction);
}

module.exports = { serializeConnection, auditar, exigirMfaEmProducao };
