'use strict';

const { IntegrationConnection, IntegrationProvider } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { serializeConnection, exigirMfaEmProducao } = require('../registry/registry.auditoria');
const { transitionConnection } = require('../registry/connections.transition');
const { assertContractReportForRelease } = require('../contract/contract.report');
const { readContractParams } = require('../contract/contract.params');

const domainMismatch = () => AppError.unprocessable('A nova integração precisa ser da mesma família.', 'INTEGRATION_SWAP_DOMAIN_MISMATCH');
const notReady = (message, code) => AppError.conflict(message, code);

async function load(id, ctx, transaction) {
  const c = await IntegrationConnection.findOne({ where: { id: String(id), companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!c) throw AppError.notFound('Integração não encontrada.', 'INTEGRATION_CONNECTION_NOT_FOUND');
  return c;
}

const domainOf = async (providerCode, transaction) => (await IntegrationProvider.findByPk(providerCode, { transaction }) || {}).domain || null;

/**
 * swapProvider — troca de fornecedor sem reescrever o domínio (INT-013, M9-D221 3.1): a connection `from` (ACTIVE) é pausada em DRENAGEM (os envios em voo terminam nela) e a
 * `to` (DRAFT ou PAUSED, mesma família e mesmo ambiente) passa a ACTIVE, tudo numa transação: se a ativação for recusada, nada muda. Nunca duas ACTIVE. Em PRODUÇÃO exige MFA
 * recente e o relatório de contract tests verde do adapter novo (M9-D222). Os identificadores INTERNOS (conversa, canal, anúncio, envelope) não mudam: cada recurso externo é o
 * par (connection, id externo) guardado no domínio, e o par antigo permanece como histórico na connection antiga. Registra a troca na auditoria (antes e depois das duas connections).
 */
async function swapProvider(ctx, { fromConnectionId, toConnectionId }, transaction) {
  if (!fromConnectionId || !toConnectionId || fromConnectionId === toConnectionId) throw AppError.badRequest('Informe duas integrações diferentes para a troca.', 'VALIDATION_ERROR');
  const [primeira, segunda] = [String(fromConnectionId), String(toConnectionId)].sort();
  const travadas = { [primeira]: await load(primeira, ctx, transaction), [segunda]: await load(segunda, ctx, transaction) };
  const from = travadas[String(fromConnectionId)];
  const to = travadas[String(toConnectionId)];
  const [domainFrom, domainTo] = [await domainOf(from.providerCode, transaction), await domainOf(to.providerCode, transaction)];
  if (!domainFrom || domainFrom !== domainTo) throw domainMismatch();
  if (from.environment !== to.environment) throw AppError.unprocessable('A troca é entre integrações do mesmo ambiente.', 'INTEGRATION_SWAP_ENVIRONMENT_MISMATCH');
  if (from.status !== 'ACTIVE') throw notReady('A integração a substituir precisa estar ativa.', 'INTEGRATION_SWAP_SOURCE_NOT_ACTIVE');
  if (!['DRAFT', 'PAUSED'].includes(to.status)) throw notReady('A nova integração precisa estar em rascunho ou pausada.', 'INTEGRATION_SWAP_TARGET_NOT_READY');
  await exigirMfaEmProducao(from.environment, ctx, transaction);
  if (from.environment === 'PRODUCTION') {
    const { reportValidityDays } = await readContractParams(ctx, transaction);
    assertContractReportForRelease(to.providerCode, { maxAgeDays: reportValidityDays });
  }
  const antes = { from: serializeConnection(from), to: serializeConnection(to) };
  await transitionConnection(from.id, 'PAUSED', ctx, transaction);
  await from.reload({ transaction });
  await from.update({ policyJson: { ...(from.policyJson || {}), swap: { draining: true, toConnectionId: to.id, at: new Date().toISOString() } } }, { transaction });
  await transitionConnection(to.id, 'ACTIVE', ctx, transaction);
  await to.reload({ transaction });
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null, action: 'integration.provider.swap', entityType: 'IntegrationConnection', entityId: to.id,
    beforeJson: antes, afterJson: { from: serializeConnection(from), to: serializeConnection(to) }, reason: `Troca de fornecedor ${from.providerCode} -> ${to.providerCode}: os envios em voo terminam na integração antiga.`,
  }, transaction);
  return { from, to };
}

module.exports = { swapProvider };
