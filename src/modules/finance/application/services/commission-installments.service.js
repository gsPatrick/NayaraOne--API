'use strict';

// Parcelas da comissão: geração, liberação proporcional ao recebimento do fato gerador, baixa
// contra lançamento liquidado e cancelamento com ajuste auditável. A criação da comissão e a
// regra REG-FIN-002 ficam em commission.service.js, que reexporta estas funções.

const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { computeRemainingAmount } = require('./ledger-balance.service');
const repo = require('../../infrastructure/repositories/commission.repository');
const {
  ADJUSTMENT_TYPE_CANCELLATION,
  planInstallments,
  toCents,
  sumPaidCents,
  buildLegacyRelease,
  buildSourceRelease,
  exceedsAvailable,
  amountsMatch,
  canTransitionInstallment,
  isCommissionCancelled,
  computeCancellationAdjustment,
} = require('../../domain/commission');

async function getCommission(id, transaction) {
  const commission = await repo.findCommissionById(id, transaction);
  if (!commission) throw AppError.notFound('Comissão não encontrada.', 'FINANCE_COMMISSION_NOT_FOUND');
  return commission;
}

/**
 * getCommissionRelease — quanto da comissão já pode ser pago: a mesma proporção do que o fato
 * gerador já recebeu (§14 "parcelada na mesma proporção do recebimento"; §10 "comissão
 * proporcional usa valor efetivamente recebido").
 */
async function getCommissionRelease(commissionOrId, transaction) {
  const commission = typeof commissionOrId === 'string' ? await getCommission(commissionOrId, transaction) : commissionOrId;
  const installments = await repo.findInstallmentsByCommission(commission.id, transaction);
  const paidCents = sumPaidCents(installments);
  const totalCents = toCents(commission.totalAmount);

  if (!commission.sourceEntryId) {
    // Comissão anterior à regra (sem fato gerador registrado): mantém o comportamento antigo.
    return buildLegacyRelease(totalCents, paidCents);
  }
  const source = await repo.findEntryById(commission.sourceEntryId, transaction);
  const baseCents = toCents(source.amount);
  // O saldo em aberto só é consultado quando o fato gerador foi recebido em parte.
  const remainingAmount = source.status === 'PARTIALLY_SETTLED' ? await computeRemainingAmount(source, transaction) : null;
  return buildSourceRelease(source, { totalCents, paidCents, baseCents, remainingAmount });
}

/**
 * generateInstallments — grava as parcelas planejadas pelo domínio (planInstallments: N parcelas
 * iguais, a última absorve a diferença de arredondamento).
 */
async function generateInstallments(commission, count, firstDueAt, actorUserId, transaction) {
  const plan = planInstallments(commission.totalAmount, count, firstDueAt);
  const installments = [];

  for (const { installmentNumber, amount, dueAt } of plan) {
    // eslint-disable-next-line no-await-in-loop
    const installment = await repo.createInstallment(
      {
        groupId: commission.groupId,
        companyId: commission.companyId,
        commissionId: commission.id,
        installmentNumber,
        amount,
        dueAt,
        paidAt: null,
        financialEntryId: null,
        status: 'PENDING',
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      transaction
    );
    installments.push(installment);
  }

  return installments;
}

async function listCommissionInstallments(commissionId, transaction) {
  return repo.listInstallmentsOrdered(commissionId, transaction);
}

/**
 * markInstallmentPaid — vincula a parcela a um lançamento financeiro (financialEntryId) já
 * liquidado — não gera dinheiro novo, só registra a baixa da parcela contra um lançamento real
 * do ledger, evitando dupla contagem.
 */
async function markInstallmentPaid(installmentId, financialEntryId, actorUserId, transaction) {
  const installment = await repo.findInstallmentByIdForUpdate(installmentId, transaction);
  if (!installment) throw AppError.notFound('Parcela de comissão não encontrada.', 'FINANCE_COMMISSION_INSTALLMENT_NOT_FOUND');
  if (installment.status === 'PAID') {
    throw AppError.conflict('Esta parcela já está paga.', 'FINANCE_COMMISSION_INSTALLMENT_ALREADY_PAID');
  }
  if (!canTransitionInstallment(installment.status, 'PAID')) {
    throw AppError.conflict(`Só é possível pagar uma parcela pendente (atual: "${installment.status}").`, 'FINANCE_COMMISSION_INSTALLMENT_INVALID_STATUS');
  }
  // Trava a comissão: duas baixas simultâneas não podem somar acima do liberado.
  const commission = await repo.findCommissionByIdForUpdate(installment.commissionId, transaction);
  if (!commission || isCommissionCancelled(commission)) {
    throw AppError.conflict('A comissão desta parcela está cancelada.', 'FINANCE_COMMISSION_CANCELLED');
  }
  // §14 "Pagamento da comissão exige disponibilidade/condição prevista na regra": só o que o
  // fato gerador já recebeu (proporcionalmente) pode ser pago.
  const release = await getCommissionRelease(commission, transaction);
  if (exceedsAvailable(installment.amount, release.availableAmount)) {
    throw AppError.conflict(
      `Parcela de ${installment.amount} acima do liberado para pagamento (${release.availableAmount}): a comissão é liberada na proporção do recebimento do fato gerador (recebido ${release.receivedAmount ?? '—'}).`,
      'FINANCE_COMMISSION_NOT_RELEASED',
      { release }
    );
  }

  // FIX (homologação 22/09/2026 — auditoria proativa): o comentário da função já prometia que a
  // baixa "não gera dinheiro novo, só registra contra um lançamento real do ledger, evitando
  // dupla contagem", mas o código nunca checava nada disso — aceitava financialEntryId
  // inexistente, de um lançamento ainda não liquidado, de valor diferente da parcela, já
  // reutilizado por outra parcela, ou nem informado (marcava PAID sem vincular a lançamento
  // nenhum). Agora a validação é real e fail-closed.
  if (!financialEntryId) {
    throw AppError.badRequest(
      'Para dar baixa na parcela, informe o lançamento financeiro já liquidado que a pagou.',
      'FINANCE_COMMISSION_INSTALLMENT_ENTRY_REQUIRED'
    );
  }
  const entry = await repo.findEntryById(financialEntryId, transaction);
  if (!entry) {
    throw AppError.notFound('Lançamento financeiro informado não encontrado.', 'FINANCE_COMMISSION_INSTALLMENT_ENTRY_NOT_FOUND');
  }
  if (entry.status !== 'SETTLED') {
    throw AppError.conflict(
      'O lançamento financeiro informado ainda não está liquidado (SETTLED).',
      'FINANCE_COMMISSION_INSTALLMENT_ENTRY_NOT_SETTLED'
    );
  }
  if (!amountsMatch(entry.amount, installment.amount)) {
    throw AppError.conflict(
      'O valor do lançamento financeiro informado não corresponde ao valor da parcela.',
      'FINANCE_COMMISSION_INSTALLMENT_ENTRY_AMOUNT_MISMATCH'
    );
  }
  const alreadyUsed = await repo.findInstallmentByFinancialEntry(financialEntryId, transaction);
  if (alreadyUsed && alreadyUsed.id !== installment.id) {
    throw AppError.conflict(
      'Este lançamento financeiro já foi usado para dar baixa em outra parcela.',
      'FINANCE_COMMISSION_INSTALLMENT_ENTRY_ALREADY_USED'
    );
  }

  const beforeJson = installment.toJSON();
  installment.status = 'PAID';
  installment.paidAt = new Date();
  installment.financialEntryId = financialEntryId;
  installment.updatedBy = actorUserId || null;
  await repo.save(installment, transaction);

  await registrarAuditoria(
    {
      groupId: installment.groupId,
      companyId: installment.companyId,
      actorUserId,
      action: 'finance.commission_installment.pay',
      entityType: 'CommissionInstallment',
      entityId: installment.id,
      beforeJson,
      afterJson: installment.toJSON(),
      reason: `Parcela ${installment.installmentNumber} da comissão paga (${installment.amount}).`,
    },
    transaction
  );

  return installment;
}

// --- M4-contrato §14 "Comissões" — ajuste por cancelamento ----------------------------------
//
// Auditoria externa (contrato bruto, 2026-10-07): "Reversão/cancelamento gera ajuste, nunca
// apaga histórico." / teste citado "FIN-TS-017 Comissão rollback | Contrato cancelado | Ajuste
// auditável." / "Comissão pode ser parcelada na mesma proporção do recebimento." O status
// CANCELLED já existia no enum, mas nenhuma função o usava — cancelar era, na prática,
// impossível (nada setava esse status) e, se alguém setasse manualmente, não haveria ajuste
// nenhum registrado, nem proporcionalidade com o que já foi pago.
//
// MODELAGEM (DDL indisponível nesta rodada — ver nota de infraestrutura no relatório final): o
// AJUSTE é um registro de auditoria append-only (`audit.audit_log`, action
// "finance.commission.cancel_adjustment") em vez de uma tabela dedicada — mesmo padrão já usado
// em owner-repasses.service.js (`getOwnerRepasseComposition`) para o mesmo problema de
// infraestrutura. A `Commission` original NUNCA é apagada: só seu `status` muda para
// CANCELLED, e todo o histórico de parcelas (`CommissionInstallment`) permanece intocado — o
// que já foi PAID continua PAID (não se "desfaz" o passado), e o ajuste registra quanto da
// comissão ainda estava em aberto (não pago) no momento do cancelamento, proporcional ao que
// JÁ foi pago/recebido.
async function cancelCommission(commissionId, reasonText, actorUserId, transaction) {
  const commission = await repo.findCommissionByIdForUpdate(commissionId, transaction);
  if (!commission) throw AppError.notFound('Comissão não encontrada.', 'FINANCE_COMMISSION_NOT_FOUND');
  if (isCommissionCancelled(commission)) {
    throw AppError.conflict('Esta comissão já está cancelada.', 'FINANCE_COMMISSION_ALREADY_CANCELLED');
  }
  if (!reasonText || !String(reasonText).trim()) {
    throw AppError.badRequest(
      'O cancelamento de uma comissão exige um motivo documentado (ajuste auditável — FIN-TS-017).',
      'FINANCE_COMMISSION_CANCEL_REASON_REQUIRED'
    );
  }

  const installments = await repo.findInstallmentsByCommission(commissionId, transaction);
  // Ajuste = saldo em aberto no cancelamento, negativo (ver computeCancellationAdjustment).
  const { paidAmountBefore, totalAmountBefore, adjustmentAmount } = computeCancellationAdjustment(installments, commission.totalAmount);

  const beforeJson = { commission: commission.toJSON(), installments: installments.map((i) => i.toJSON()) };

  commission.status = 'CANCELLED';
  commission.updatedBy = actorUserId || null;
  await repo.save(commission, transaction);

  // Parcelas ainda não pagas são canceladas (preservando a linha — nunca DELETE); as já PAID
  // permanecem PAID, intocadas, exatamente como "nunca apaga histórico" exige.
  for (const installment of installments) {
    if (canTransitionInstallment(installment.status, 'CANCELLED')) {
      // eslint-disable-next-line no-await-in-loop
      installment.status = 'CANCELLED';
      installment.updatedBy = actorUserId || null;
      // eslint-disable-next-line no-await-in-loop
      await repo.save(installment, transaction);
    }
  }

  await registrarAuditoria(
    {
      groupId: commission.groupId,
      companyId: commission.companyId,
      actorUserId,
      action: 'finance.commission.cancel_adjustment',
      entityType: 'Commission',
      entityId: commission.id,
      beforeJson,
      afterJson: {
        commission: commission.toJSON(),
        adjustment: {
          adjustmentType: ADJUSTMENT_TYPE_CANCELLATION,
          paidAmountBefore,
          totalAmountBefore,
          adjustmentAmount,
        },
      },
      reason: `Comissão cancelada (contrato cancelado): ${reasonText}. Já pago/recebido ${paidAmountBefore} de ${totalAmountBefore} — ajuste de ${adjustmentAmount} sobre o saldo em aberto.`,
    },
    transaction
  );

  return {
    commission,
    adjustment: { adjustmentType: ADJUSTMENT_TYPE_CANCELLATION, paidAmountBefore, totalAmountBefore, adjustmentAmount },
  };
}

/**
 * getCommissionAdjustments — histórico de ajustes (cancelamentos) de uma comissão, lido do
 * rastro de auditoria append-only (ver nota de modelagem acima).
 */
async function getCommissionAdjustments(commissionId, transaction) {
  const logs = await repo.listCancellationAdjustmentLogs(commissionId, transaction);
  return logs.map((log) => (log.afterJson || {}).adjustment).filter(Boolean);
}

module.exports = {
  getCommission,
  getCommissionRelease,
  generateInstallments,
  listCommissionInstallments,
  markInstallmentPaid,
  cancelCommission,
  getCommissionAdjustments,
};
