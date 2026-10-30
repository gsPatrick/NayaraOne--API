'use strict';

const { IntegrationConnection, IntegrationDispatch } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { publishDomainEvent } = require('../../../engines/events/outbox');
const { moveQueuedDispatch } = require('../dispatch/dispatch.move');
const { portOperation } = require('../dispatch/enqueue/resolveTarget');
const { EVENTS, QUEUED_STATUSES } = require('./contingency.constants');
const { resolveContingencyPolicy } = require('./contingency.policy');
const { checkAlternate, assertAlternate } = require('./contingency.alternate');
const { isAlternateSafe } = require('./contingency.alternateSafe');
const { runDispatchMoved } = require('./contingency.domainHooks');

const exigeAprovacao = () => AppError.forbidden('A troca de fornecedor nesta operação exige aprovação humana.', 'INTEGRATION_ALTERNATE_REQUIRES_APPROVAL');

async function travarEnvio(ctx, dispatchId, transaction) {
  const row = await IntegrationDispatch.findOne({ where: { id: dispatchId, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!row) throw AppError.notFound('Envio não encontrado.', 'INTEGRATION_DISPATCH_NOT_FOUND');
  if (!QUEUED_STATUSES.includes(row.status)) throw AppError.conflict('Só um envio que ainda está na fila pode trocar de fornecedor.', 'INTEGRATION_DISPATCH_NOT_QUEUED');
  return row;
}

/** Cria o envio equivalente no alternativo (mesma chave, mesmo conteúdo aprovado) e cancela o da fila do principal. */
async function moveTo(ctx, old, alt, motivo, transaction, domain) {
  const novo = await moveQueuedDispatch(ctx, old, alt, motivo, transaction);
  await runDispatchMoved(domain, ctx, { from: old, to: novo, alternate: alt }, transaction);
  await publishDomainEvent({
    groupId: ctx.groupId, companyId: ctx.companyId, aggregateType: 'IntegrationDispatch', aggregateId: old.id, eventType: EVENTS.SWITCHED,
    payload: { fromDispatchId: old.id, toDispatchId: novo.id, fromConnectionId: old.connectionId, toConnectionId: alt.id, operation: old.operation },
    idempotencyKey: `${EVENTS.SWITCHED}:${old.id}`,
  }, transaction);
  return { fromDispatchId: old.id, toDispatchId: novo.id, toConnectionId: alt.id, switched: true };
}

/**
 * Troca um envio da fila para o fornecedor alternativo da política (M9-D226 3.3 item 2). Operação marcada `alternate_safe` troca sozinha (`auto`);
 * operação perigosa só com `approved` (quem chama já conferiu `integration:manage` e MFA): sem isso, 403 INTEGRATION_ALTERNATE_REQUIRES_APPROVAL.
 * Alternativo inelegível: 409 INTEGRATION_ALTERNATE_NOT_ELIGIBLE (no modo `auto` o envio só permanece na fila).
 */
async function switchToAlternate(ctx, dispatchId, { approved = false, auto = false, now = new Date() } = {}, transaction) {
  const old = await travarEnvio(ctx, dispatchId, transaction);
  const primary = await IntegrationConnection.findOne({ where: { id: old.connectionId, companyId: ctx.companyId }, transaction });
  const policy = await resolveContingencyPolicy(ctx, primary, transaction);
  const { provider, def } = await portOperation(primary.providerCode, old.operation, transaction);
  const seguro = isAlternateSafe(provider && provider.domain, old.operation, def);
  if (!seguro && !approved) {
    if (auto) return { switched: false, reason: 'REQUIRES_APPROVAL' };
    throw exigeAprovacao();
  }
  const motivo = `Troca para o fornecedor alternativo na contingência${seguro ? '' : ' (aprovada por uma pessoa)'}.`;
  if (auto) {
    const r = await checkAlternate(ctx, primary, policy && policy.alternateConnectionId, old.operation, now, transaction);
    return r.connection ? moveTo(ctx, old, r.connection, motivo, transaction, provider && provider.domain) : { switched: false, reason: r.motivo };
  }
  const alt = await assertAlternate(ctx, primary, policy && policy.alternateConnectionId, old.operation, now, transaction);
  return moveTo(ctx, old, alt, motivo, transaction, provider && provider.domain);
}

module.exports = { switchToAlternate };
