'use strict';

const { Company } = require('../../../models');
const { publishDomainEvent } = require('../../../engines/events/outbox');
const { resolveError } = require('../errors');
const { EVENTS } = require('./contingency.constants');
const { resolveContingencyPolicy, resolvePolicyFor } = require('./contingency.policy');
const { openActive, toView } = require('./contingency.state');
const { notifyContingency } = require('./contingency.notify');

const MENSAGEM = (p) => `Plano de contingência ativado (modo ${p.mode}): a integração está fora do ar e a operação segue pela fila, pelo alternativo ou pelo fluxo manual.`;

async function publish(ctx, eventType, row, view, transaction) {
  return publishDomainEvent({
    groupId: ctx.groupId, companyId: ctx.companyId, aggregateType: 'IntegrationContingency', aggregateId: row.id, eventType,
    payload: { contingencyId: row.id, connectionId: view.connectionId, providerCode: view.providerCode, domain: view.domain, mode: view.mode, reasons: view.reasons },
    idempotencyKey: `${eventType}:${row.id}`,
  }, transaction);
}

/** Contexto { groupId, companyId } de uma empresa (para o gancho de contingência, que só recebe o id da empresa). */
async function ctxFromCompany(companyId, transaction) {
  const company = await Company.findByPk(companyId, { attributes: ['id', 'groupId'], transaction });
  return company ? { groupId: company.groupId, companyId: company.id } : null;
}

/**
 * Ativa a contingência (M9-D226 3.2). `target`: { connection } ou { domain, providerCode }; `reasons`: lista de REASONS. Família sem modo
 * de contingência não ativa nada. Ativar de novo enquanto ativa é no-op ({ activated: false }). Publica `integration.contingency.activated`
 * uma vez, avisa os papéis de `notify_roles` e deixa a linha CONTINGENCY_ACTIVE (auditada na tabela de erros).
 */
async function activateContingency(ctx, target, reasons, transaction) {
  const policy = target.connection
    ? await resolveContingencyPolicy(ctx, target.connection, transaction)
    : await resolvePolicyFor(ctx, { providerCode: target.providerCode, domain: target.domain }, transaction);
  if (!policy) return { activated: false, reason: 'NO_CONTINGENCY_MODE' };
  const scope = target.connection ? { connectionId: target.connection.id } : { domain: policy.domain };
  const details = { mode: policy.mode, reasons, domain: policy.domain, providerCode: target.connection ? target.connection.providerCode : target.providerCode || null };
  const { row, created } = await openActive(ctx, scope, details, MENSAGEM(policy), transaction);
  const view = toView(row);
  if (!created) return { activated: false, row, view, policy };
  await publish(ctx, EVENTS.ACTIVATED, row, view, transaction);
  await notifyContingency(ctx, 'ACTIVATED', view, policy.notifyRoles, transaction);
  return { activated: true, row, view, policy };
}

/** Encerra a contingência (resolve a linha, publica `integration.contingency.deactivated` e avisa). Já encerrada: no-op. */
async function deactivateContingency(ctx, row, note, policy, transaction) {
  if (row.status !== 'OPEN') return { deactivated: false };
  const view = toView(row);
  await resolveError(row.id, { note }, ctx, transaction, { auditAction: EVENTS.DEACTIVATED, reason: `Contingência encerrada: ${note}` });
  await publish(ctx, EVENTS.DEACTIVATED, row, view, transaction);
  await notifyContingency(ctx, 'DEACTIVATED', view, (policy && policy.notifyRoles) || ['ADMIN'], transaction);
  return { deactivated: true, view };
}

module.exports = { activateContingency, deactivateContingency, ctxFromCompany };
