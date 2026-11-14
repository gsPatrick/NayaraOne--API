'use strict';

/**
 * Reabertura de período — fluxo CRITICAL (Caderno §16 "Reabertura requer permissão CRITICAL, MFA, motivo e auditoria"; §2 FIN-012
 * "reabertura é excepcional"; Guia §18 "Não reabrir fechamento sem fluxo CRITICAL"; FIN-TS-011 "Reabrir — usuário comum — Negado").
 *
 *   1. Pedido: permissão própria finance:periodReopen + MFA recente (rotas), motivo com o mínimo de fechamento.reabertura_motivo_minimo_caracteres.
 *      Abre um pedido de aprovação CRITICAL com o retrato do fechamento (snapshot do mês) e o hash dele. O mês continua CLOSED.
 *   2. Aprovação: OUTRA pessoa, também com finance:periodReopen e MFA recente; o nº de aprovações é fechamento.reabertura.aprovadores
 *      (padrão 1 — duas pessoas no total, DI-M4PG-4). Atingido o nº, o mês reabre (closing.service applyPeriodReopen) e tudo vai à auditoria.
 *   3. Recusa encerra o pedido sem reabrir. Se o fechamento mudar entre o pedido e a aprovação, o pedido vira STALE.
 * Fechar exige duas pessoas (quem pede e quem aprova, com finance:approve e MFA); reabrir exige o mesmo nº de pessoas, com permissão mais
 * restrita e MFA nas duas pontas.
 */
const AppError = require('../../../../utils/AppError');
const { ApprovalRequest } = require('../../../../models');
const { publishCadernoEvent } = require('./finance-events.service');
const workflow = require('./approval-workflow');
const { KEYS, readNumber } = require('./payment-approval-settings');
const closing = require('./closing.service');
const { assertValidReferenceMonth, monthBR } = require('./closing-period-guards.service');
const { computeSnapshotHash } = require('../../domain/payment-intent');

const TYPE = 'PeriodReopen';

function closureSnapshot(closure) {
  return {
    closureId: closure.id,
    companyId: closure.companyId,
    referenceMonth: closure.referenceMonth,
    status: closure.status,
    currentSnapshotId: closure.currentSnapshotId || null,
    closedAt: closure.closedAt ? new Date(closure.closedAt).toISOString() : null,
  };
}

async function requestPeriodReopen(payload, actorUserId, transaction) {
  const { companyId, groupId } = payload;
  if (!companyId) throw AppError.badRequest('O campo "companyId" é obrigatório.', 'FINANCE_PERIOD_VALIDATION');
  const referenceMonth = assertValidReferenceMonth(payload.referenceMonth);
  const reason = payload.reason ? String(payload.reason).trim() : '';
  const tenant = { groupId, companyId };
  const minChars = await readNumber(KEYS.reopenReasonMinChars, tenant, transaction);
  if (!reason) {
    throw AppError.badRequest('O campo "reason" é obrigatório para reabrir um período fechado (justificativa auditável).', 'FINANCE_PERIOD_REOPEN_REASON_REQUIRED');
  }
  if (reason.length < minChars) {
    throw AppError.badRequest(`Explique a reabertura com pelo menos ${minChars} caracteres.`, 'FINANCE_PERIOD_REOPEN_REASON_TOO_SHORT', { minChars });
  }
  const closure = await closing.getClosureByMonth(companyId, referenceMonth, transaction, { forUpdate: true });
  if (!closure) throw AppError.notFound(`Não há fechamento registrado para o período ${monthBR(referenceMonth)}.`, 'FINANCE_PERIOD_NOT_FOUND');
  if (closure.status !== 'CLOSED') throw AppError.conflict(`O período ${monthBR(referenceMonth)} não está fechado.`, 'FINANCE_PERIOD_NOT_CLOSED');
  const pending = await workflow.findPendingFor(TYPE, closure.id, transaction);
  if (pending) throw AppError.conflict(`Já existe um pedido de reabertura de ${monthBR(referenceMonth)} aguardando aprovação.`, 'FINANCE_PERIOD_REOPEN_ALREADY_REQUESTED', { requestId: pending.id });

  const required = await readNumber(KEYS.reopenApprovers, tenant, transaction);
  const request = await workflow.createApprovalFor(
    {
      groupId: closure.groupId,
      companyId: closure.companyId,
      relatedEntityType: TYPE,
      relatedEntityId: closure.id,
      riskLevel: 'CRITICAL',
      requiredApprovals: required,
      riskSource: 'PARAMETERS',
      snapshot: closureSnapshot(closure),
      reason,
      payload: { referenceMonth },
    },
    actorUserId,
    transaction
  );
  // Caderno §3.3 (CRITICAL = ... + alerta + trilha): o pedido sai no outbox para quem acompanha o Financeiro.
  await publishCadernoEvent('finance.period.reopen_requested', 'PeriodClosure', closure,
    { id: closure.id, referenceMonth, approvalRequestId: request.id, requestedByUserId: actorUserId }, request.id, transaction);
  return request;
}

async function getRequestForUpdate(id, transaction) {
  const request = await workflow.getApprovalForUpdate(id, transaction);
  if (request.relatedEntityType !== TYPE) throw AppError.notFound('Pedido de reabertura não encontrado.', 'FINANCE_PERIOD_REOPEN_REQUEST_NOT_FOUND');
  return request;
}

async function decidePeriodReopen(id, decision, actorUserId, transaction) {
  const request = await getRequestForUpdate(id, transaction);
  const referenceMonth = request.payloadJson && request.payloadJson.referenceMonth;
  const closure = await closing.getClosureByMonth(request.companyId, referenceMonth, transaction, { forUpdate: true });
  if (decision === 'APPROVED' && request.status === 'PENDING' && (!closure || computeSnapshotHash(closureSnapshot(closure)) !== request.snapshotHash)) {
    await workflow.markStale(request, 'O fechamento mudou depois do pedido de reabertura.', actorUserId, transaction);
    return { request, stale: true };
  }
  const result = await workflow.recordDecision(request, { decision, approverUserId: actorUserId, requireMfa: true }, transaction);
  if (request.status !== 'APPROVED') return { request, approvedCount: result.approvedCount, required: result.required };
  const reopened = await closing.applyPeriodReopen(
    { companyId: request.companyId, referenceMonth, reason: request.reason },
    actorUserId,
    transaction,
    { requestedByUserId: request.requestedByUserId, approvalRequestId: request.id }
  );
  return { request, closure: reopened, approvedCount: result.approvedCount, required: result.required };
}

async function listPeriodReopenRequests(transaction, filters = {}) {
  const where = { relatedEntityType: TYPE };
  if (filters.status) where.status = String(filters.status).toUpperCase();
  const requests = await ApprovalRequest.findAll({ where, order: [['created_at', 'DESC']], transaction });
  const out = [];
  for (const r of requests) out.push({ ...r.toJSON(), requiredApprovals: workflow.requiredApprovalsOf(r), decisions: await workflow.listApprovers(r.id, transaction) });
  return out;
}

module.exports = {
  TYPE,
  requestPeriodReopen,
  approvePeriodReopen: (id, actorUserId, transaction) => decidePeriodReopen(id, 'APPROVED', actorUserId, transaction),
  rejectPeriodReopen: (id, actorUserId, transaction) => decidePeriodReopen(id, 'REJECTED', actorUserId, transaction),
  listPeriodReopenRequests,
};
