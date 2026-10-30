'use strict';

const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { carregarTravada } = require('./connections.service');
const { serializeConnection } = require('./registry.auditoria');
const { evaluateConnection, releaseStateOf, evidenceMissing } = require('./releaseGate');
const { STATES } = require('./release.constants');

/**
 * Libera a connection de PRODUÇÃO (M9-D256 3.2): NOT_RELEASED -> RELEASED, preenchendo `production_released_at` e `production_released_by`. Exige a aprovação humana
 * (a pessoa tem `integration:manage` na rota e MFA recente aqui, SEMPRE, independente do parâmetro de MFA em mudança de produção) e todas as evidências do portão;
 * falta de evidência é 409 INTEGRATION_RELEASE_EVIDENCE_MISSING com a lista. A connection é lida com FOR UPDATE: duas liberações simultâneas liberam uma vez só.
 * Audita antes e depois. Voltar a não liberada é pelo status da connection (PAUSED ou DISABLED).
 */
async function releaseConnection(id, ctx, transaction) {
  const c = await carregarTravada(id, ctx, transaction);
  if (c.environment !== 'PRODUCTION') throw AppError.conflict('Só uma integração de produção é liberada por este portão.', 'INTEGRATION_RELEASE_ENVIRONMENT_INVALID');
  if (c.status === 'DISABLED') throw AppError.conflict('Integração desativada não pode ser liberada: crie outra.', 'INTEGRATION_CONNECTION_INVALID_TRANSITION');
  if (releaseStateOf(c) === STATES.RELEASED) throw AppError.conflict('Esta integração já foi liberada para produção.', 'INTEGRATION_RELEASE_ALREADY_RELEASED');
  const { assertRecentMfa } = require('../../users/mfa.service');
  await assertRecentMfa(ctx.userId, transaction);
  const avaliacao = await evaluateConnection(c, ctx, transaction);
  if (!avaliacao.ready) throw evidenceMissing(avaliacao.missing);
  const antes = serializeConnection(c);
  c.productionReleasedAt = new Date();
  c.productionReleasedBy = ctx.userId || null;
  c.updatedBy = ctx.userId || null;
  await c.save({ transaction });
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null, action: 'integration.connection.production_released', entityType: 'IntegrationConnection', entityId: c.id,
    beforeJson: antes, afterJson: serializeConnection(c), reason: `Integração "${c.label}" liberada para produção com todas as evidências e aprovação humana com MFA.`,
  }, transaction);
  return c;
}

module.exports = { releaseConnection };
