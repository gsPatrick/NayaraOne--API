'use strict';

const { IntegrationDispatch } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { retryDispatchManually } = require('../../dispatch/dispatch.retry');
const { probeProvider } = require('../../dispatch/reconcile/reconcile.probe');
const { applyFound, view } = require('../../dispatch/reconcile/reconcile.apply');
const { auditReconcile } = require('../../dispatch/reconcile/reconcile.audit');
const { classifyExternalStatus } = require('../../dispatch/reconcile/reconcile.outcome');
const { FOUND } = require('../../dispatch/reconcile/reconcile.lookup');
const { assertRecentMfa } = require('../../../users/mfa.service');
const { notAllowed, confirmRequired } = require('./retry.errors');

const RETRYABLE = Object.freeze(['FAILED', 'DEAD_LETTER', 'UNKNOWN']);
const jaConfirmado = () => AppError.conflict('Esta operação já foi confirmada pelo fornecedor.', 'INTEGRATION_DISPATCH_ALREADY_CONFIRMED');

/** Depois da reconciliação: o fornecedor JÁ tem a operação? Devolve o conflito (a mudança é gravada e o erro responde depois do commit) ou null para seguir. */
async function decideAfterProbe(ctx, row, probe, transaction) {
  const before = view(row);
  if (probe.verdict !== FOUND) {
    await auditReconcile(ctx, { dispatchId: row.id, before, after: before, result: probe.verdict, trail: probe.trail, source: 'HUMAN_RETRY', reason: `Reconciliação antes do retry humano: ${probe.verdict}.` }, transaction);
    return null;
  }
  const destino = classifyExternalStatus(probe.found.status);
  if (row.status === 'UNKNOWN') {
    // Envio incerto: o fornecedor respondeu, então a conclusão (confirmado, recusado ou em andamento) vale como a da reconciliação automática.
    const r = await applyFound(ctx, row, probe.found, { source: 'STATUS_QUERY' }, transaction);
    await auditReconcile(ctx, { dispatchId: row.id, before, after: view(r.row), result: probe.verdict, trail: probe.trail, source: 'HUMAN_RETRY', reason: `Reconciliação antes do retry humano: o fornecedor tem a operação (${probe.found.status}).` }, transaction);
    return destino === 'CONFIRMED' ? jaConfirmado() : notAllowed({ providerStatus: probe.found.status, hint: 'O fornecedor já tem esta operação; confira o resultado antes de qualquer repetição.' });
  }
  // FAILED ou DEAD_LETTER: a máquina de estados não leva a CONFIRMED daqui; o fornecedor ter a operação (em andamento ou concluída) impede repetir. Recusada pelo fornecedor: segue com a aprovação humana.
  await auditReconcile(ctx, { dispatchId: row.id, before, after: before, result: probe.verdict, trail: probe.trail, source: 'HUMAN_RETRY', reason: `Reconciliação antes do retry humano: o fornecedor tem a operação (${probe.found.status}).` }, transaction);
  if (destino === 'FAILED') return null;
  return destino === 'CONFIRMED' ? jaConfirmado() : notAllowed({ providerStatus: probe.found.status, hint: 'O fornecedor já tem esta operação; confira o resultado antes de qualquer repetição.' });
}

/**
 * Retry de um erro DISPATCH (M9-D250 3.1 item 2). O envio é o `source_ref_id` do erro, travado com FOR UPDATE. Operação perigosa: MFA recente, `confirmDangerous` e a
 * reconciliação (D215) antes de repetir; a aprovação humana (MFA + motivo + confirmação) cobre a consulta inconclusiva. O envio volta a RETRY_WAIT com a MESMA chave e o MESMO
 * hash (D205). Devolve { dispatchId } ou { dispatchId, conflict } quando a repetição foi recusada depois de gravar o que a reconciliação descobriu.
 */
async function retryDispatchError(ctx, error, { reason, confirmDangerous }, params, transaction) {
  const row = error.financingCaseId
    ? await IntegrationDispatch.findOne({ where: { id: error.financingCaseId, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE })
    : null;
  if (!row) throw notAllowed({ reason: 'DISPATCH_NOT_FOUND' });
  if (row.status === 'CONFIRMED') throw jaConfirmado();
  if (!RETRYABLE.includes(row.status)) throw notAllowed({ dispatchStatus: row.status });
  const dangerous = row.criticalityOp === 'DANGEROUS';
  if (dangerous) {
    await assertRecentMfa(ctx.userId, transaction);
    if (confirmDangerous !== true) throw confirmRequired();
    const probe = await probeProvider(ctx, row, transaction);
    const conflict = await decideAfterProbe(ctx, row, probe, transaction);
    if (conflict) return { dispatchId: row.id, dangerous, conflict };
    await row.reload({ transaction, lock: transaction.LOCK.UPDATE });
  }
  await retryDispatchManually(ctx, row.id, transaction, { reason, reconciled: dangerous, extraAttempts: params.humanExtraAttempts });
  return { dispatchId: row.id, dangerous };
}

module.exports = { retryDispatchError };
