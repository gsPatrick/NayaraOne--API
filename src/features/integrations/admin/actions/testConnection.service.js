'use strict';

const { sequelize } = require('../../../../models');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { assertRecentMfa } = require('../../../users/mfa.service');
const { transitionConnection } = require('../../registry/connections.transition');
const { readActionParams } = require('./actions.params');
const { parseTestBody } = require('./actions.body');
const { resolveActionConnection } = require('./actions.connection');
const { runConnectionProbe } = require('./testConnection.probe');

const MANAGE_PERMISSION = 'integration:manage';
const podeGerenciar = (ctx) => Array.isArray(ctx.permissions) && ctx.permissions.includes(MANAGE_PERMISSION);

/** Teste verde reativa a connection AUTH_FAILED (M9-D216) quando quem testa tem integration:manage. A recusa da reativação (outra ativa, produção não liberada) não derruba o teste. */
async function reactivateIfAuthFailed(connection, ctx, transaction) {
  if (connection.status !== 'AUTH_FAILED' || !podeGerenciar(ctx)) return { done: false };
  try {
    await sequelize.transaction({ transaction }, (savepoint) => transitionConnection(connection.id, 'ACTIVE', ctx, savepoint, { testConnectionOk: true }));
    return { done: true };
  } catch (err) {
    return { done: false, reason: err && err.isOperational ? err.message : 'Não foi possível reativar a integração.' };
  }
}

/** Auditoria `integration.connection.tested`: resultado e checks por nome; sem segredo, sem referência do cofre. */
async function auditTested(ctx, connection, result, reativacao, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null, action: 'integration.connection.tested', entityType: 'IntegrationConnection', entityId: connection.id,
    beforeJson: { status: connection.status },
    afterJson: { ok: result.ok, latencyMs: result.latencyMs, checks: result.checks, environment: connection.environment, providerCode: connection.providerCode, reactivated: reativacao.done },
    reason: `Teste de conexão (${connection.environment}): ${result.ok ? 'ok' : 'falhou'}.`,
  }, transaction);
}

/**
 * POST /admin/integrations/:provider/test-connection (M9-D250 3.2). PRODUCTION exige MFA recente (parâmetro integration.admin.mfa_on_prod_test_connection). Falha do teste é 200 com ok:false;
 * connection inexistente é 404. O teste verde reativa a connection AUTH_FAILED. Devolve { ok, latencyMs, checks, message } e, só quando houve reativação, `reactivated`.
 */
async function testConnection(providerCode, rawBody, ctx, transaction) {
  const body = parseTestBody(rawBody);
  const params = await readActionParams(ctx, transaction);
  if (body.environment === 'PRODUCTION' && params.mfaOnProdTest) await assertRecentMfa(ctx.userId, transaction);
  const { connection, provider } = await resolveActionConnection(providerCode, body, ctx, transaction);
  const result = await runConnectionProbe(connection, provider, ctx, transaction, { timeoutMs: params.testTimeoutMs });
  const reativacao = result.ok ? await reactivateIfAuthFailed(connection, ctx, transaction) : { done: false };
  await auditTested(ctx, connection, result, reativacao, transaction);
  return { ...result, ...(reativacao.done ? { reactivated: true } : {}) };
}

module.exports = { testConnection };
