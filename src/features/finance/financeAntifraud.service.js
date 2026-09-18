'use strict';

const { Op } = require('sequelize');

const AppError = require('../../utils/AppError');
const { BankAccount, FinancialEntry, Notification, UserMembership } = require('../../models');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

// Regras de antifraude do Financeiro Base (01_ARQUITETURA_E_INVARIANTES.md — bloco Antifraude/
// 03_MOTORES_TRANSVERSAIS.md — gatilhos "mudança bancária + pagamento em janela curta" e
// "conta bancária nova exige período de resfriamento").
//
// IMPORTANTE (transparência de escopo): a migration de finance.bank_accounts NÃO tem uma
// coluna dedicada tipo `cooldown_until` — o cooldown é derivado do próprio `created_at`
// (padrão já usado no projeto para não precisar de coluna extra: ver radarMatchingJob.js).
// Da mesma forma, `finance.approval_requests` NÃO tem uma coluna `snapshot_hash` — a proteção
// "se alterar conta/valor a aprovação invalida" é implementada via lock otimista
// (`lock_version`, coluna que já existe em FinancialEntry/Commission/OwnerRepass/BankAccount)
// comparado no momento da decisão, não por um hash armazenado. Ver approvals.service.js.

const BANK_ACCOUNT_COOLDOWN_HOURS = Number(process.env.FINANCE_BANK_ACCOUNT_COOLDOWN_HOURS) || 48;

function hoursSince(date) {
  return (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60);
}

/**
 * assertBankAccountEligibleForPayment — bloqueia pagamento/repasse para uma conta bancária:
 *   - com status BLOCKED (bloqueio manual/antifraude);
 *   - ainda em PENDING_COOLDOWN e dentro da janela de resfriamento (conta nova OU dado
 *     sensível alterado recentemente — ver bankAccounts.service.js, que reabre o cooldown
 *     sempre que bank_code/agency/account_number/pix_key mudam).
 * Promove automaticamente PENDING_COOLDOWN → ACTIVE quando o prazo já passou (mesma técnica
 * "lazy transition" do resto do projeto, sem job dedicado).
 */
async function assertBankAccountEligibleForPayment(bankAccountId, transaction) {
  if (!bankAccountId) return null;

  const bankAccount = await BankAccount.findByPk(bankAccountId, { transaction });
  if (!bankAccount) throw AppError.notFound('Conta bancária não encontrada.', 'FINANCE_BANK_ACCOUNT_NOT_FOUND');

  if (bankAccount.status === 'BLOCKED') {
    throw AppError.conflict(
      'Esta conta bancária está bloqueada para pagamentos (antifraude). Desbloqueie antes de prosseguir.',
      'FINANCE_BANK_ACCOUNT_BLOCKED'
    );
  }

  if (bankAccount.status === 'PENDING_COOLDOWN') {
    const elapsed = hoursSince(bankAccount.updated_at || bankAccount.created_at);
    if (elapsed < BANK_ACCOUNT_COOLDOWN_HOURS) {
      const remaining = Math.ceil(BANK_ACCOUNT_COOLDOWN_HOURS - elapsed);
      throw AppError.conflict(
        `Conta bancária em período de resfriamento (antifraude) — faltam ${remaining}h para ficar elegível a pagamentos. ` +
          'Isso protege contra troca fraudulenta de dados bancários seguida de pagamento imediato.',
        'FINANCE_BANK_ACCOUNT_COOLDOWN'
      );
    }
    bankAccount.status = 'ACTIVE';
    await bankAccount.save({ transaction });
  }

  return bankAccount;
}

/**
 * assertNoDuplicatePayment — checagem explícita de idempotência antes de liquidar/pagar (a
 * unicidade de `idempotency_key` no banco já impede o INSERT duplicado, mas aqui damos um erro
 * de negócio claro e antecipado em vez de deixar estourar como erro de constraint de banco).
 */
async function assertNoDuplicatePayment(Model, idempotencyKey, transaction) {
  if (!idempotencyKey) return;
  const existing = await Model.findOne({ where: { idempotencyKey }, transaction });
  if (existing) {
    throw AppError.conflict(
      'Já existe um lançamento com esta mesma chave de idempotência — pagamento/recebimento duplicado bloqueado.',
      'FINANCE_DUPLICATE_PAYMENT',
      { existingId: existing.id }
    );
  }
}

// --- M4-21: detecção de anomalia + revisão manual de beneficiário ---------------------------
//
// CRITÉRIOS (decisão de engenharia documentada — não há limiar definido no schema/documento;
// ambos são configuráveis por env pra poder calibrar sem deploy de código):
//   (A) DESVIO DO HISTÓRICO: o valor do pagamento é >= 3x a MÉDIA dos pagamentos já liquidados
//       para a MESMA bankAccountId (beneficiário). Só vale a partir de um mínimo de histórico
//       (2 pagamentos) — com 1 só pagamento a "média" não significa nada e geraria ruído.
//   (B) PRIMEIRO PAGAMENTO GRANDE: conta bancária sem nenhum pagamento liquidado no histórico
//       recebendo de cara um valor >= R$ 10.000 — o padrão clássico de fraude de beneficiário
//       (cadastra conta nova e manda o valor cheio).
// Ao detectar, o LANÇAMENTO é marcado com requires_manual_review = true (fica retido: o
// financialEntries.service recusa liquidar, total ou parcialmente, enquanto o flag estiver
// ligado) e o time financeiro é notificado (Notification IN_APP, mesmo padrão do
// legalDeadlineAlertJob). A liberação é sempre humana e auditada — `clearManualReview`.

const ANOMALY_HISTORY_MULTIPLIER = Number(process.env.FINANCE_ANOMALY_MULTIPLIER) || 3;
const ANOMALY_MIN_HISTORY = 2;
const ANOMALY_NEW_ACCOUNT_THRESHOLD = Number(process.env.FINANCE_ANOMALY_NEW_ACCOUNT_THRESHOLD) || 10000;

/**
 * flagAnomalousPayment — avalia o lançamento contra os critérios acima. Retorna
 * `{ flagged: false }` quando nada foi detectado (e NÃO altera nada), ou
 * `{ flagged: true, reason, notifiedUserIds }` quando marcou o lançamento para revisão manual.
 */
async function flagAnomalousPayment(financialEntry, transaction) {
  if (!financialEntry || !financialEntry.bankAccountId) return { flagged: false, reason: null };
  if (financialEntry.requiresManualReview) return { flagged: false, reason: null, alreadyFlagged: true };

  const amount = Number(financialEntry.amount);

  // Histórico = pagamentos JÁ liquidados da mesma conta bancária, excluindo o próprio
  // lançamento e qualquer baixa parcial dele (parent_entry_id), pra não se comparar consigo mesmo.
  const history = await FinancialEntry.findAll({
    where: {
      bankAccountId: financialEntry.bankAccountId,
      status: 'SETTLED',
      parentEntryId: null,
      id: { [Op.ne]: financialEntry.id },
    },
    transaction,
  });

  let reason = null;
  if (history.length >= ANOMALY_MIN_HISTORY) {
    const average = history.reduce((acc, e) => acc + Number(e.amount), 0) / history.length;
    if (average > 0 && amount >= average * ANOMALY_HISTORY_MULTIPLIER) {
      reason =
        `Valor ${amount.toFixed(2)} é ${(amount / average).toFixed(1)}x a média histórica ` +
        `(${average.toFixed(2)}) dos ${history.length} pagamentos já liquidados desta conta bancária.`;
    }
  } else if (history.length === 0 && amount >= ANOMALY_NEW_ACCOUNT_THRESHOLD) {
    reason =
      `Primeiro pagamento desta conta bancária já no valor de ${amount.toFixed(2)} ` +
      `(limite para conta sem histórico: ${ANOMALY_NEW_ACCOUNT_THRESHOLD.toFixed(2)}).`;
  }

  if (!reason) return { flagged: false, reason: null };

  const beforeJson = financialEntry.toJSON();
  financialEntry.requiresManualReview = true;
  financialEntry.manualReviewReason = reason;
  financialEntry.manualReviewClearedAt = null;
  financialEntry.manualReviewClearedBy = null;
  await financialEntry.save({ transaction });

  // Notifica o time financeiro do tenant. Sem um "grupo/papel financeiro" modelado no schema,
  // usamos os usuários com membership ativa na empresa — quem opera o financeiro do tenant.
  const memberships = await UserMembership.findAll({
    where: { companyId: financialEntry.companyId },
    transaction,
  });
  const notifiedUserIds = [...new Set(memberships.map((m) => m.userId).filter(Boolean))];
  for (const userId of notifiedUserIds) {
    await Notification.create(
      {
        groupId: financialEntry.groupId,
        companyId: financialEntry.companyId,
        userId,
        channel: 'IN_APP',
        title: 'Pagamento anômalo retido para revisão manual',
        body: `Lançamento ${financialEntry.id} (${Number(financialEntry.amount).toFixed(2)}) foi retido pelo antifraude. Motivo: ${reason}`,
        createdBy: null,
        updatedBy: null,
      },
      { transaction }
    );
  }

  await registrarAuditoria(
    {
      groupId: financialEntry.groupId,
      companyId: financialEntry.companyId,
      actorUserId: null,
      action: 'finance.antifraud.manual_review_required',
      entityType: 'FinancialEntry',
      entityId: financialEntry.id,
      beforeJson,
      afterJson: financialEntry.toJSON(),
      reason: `Antifraude reteve o pagamento para revisão manual: ${reason}`,
    },
    transaction
  );

  return { flagged: true, reason, notifiedUserIds };
}

/**
 * clearManualReview — liberação HUMANA do lançamento retido. Registra quem liberou e quando
 * (manual_review_cleared_by/at) e audita — a trilha de "quem revisou" nunca se perde.
 */
async function clearManualReview(entityId, actorUserId, transaction, reviewNote) {
  if (!actorUserId) {
    throw AppError.forbidden(
      'A liberação de um pagamento retido por antifraude exige um revisor humano identificado.',
      'FINANCE_MANUAL_REVIEW_ACTOR_REQUIRED'
    );
  }
  const entry = await FinancialEntry.findByPk(entityId, { transaction });
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  if (!entry.requiresManualReview) {
    throw AppError.conflict('Este lançamento não está retido para revisão manual.', 'FINANCE_MANUAL_REVIEW_NOT_PENDING');
  }

  const beforeJson = entry.toJSON();
  entry.requiresManualReview = false;
  entry.manualReviewClearedAt = new Date();
  entry.manualReviewClearedBy = actorUserId;
  entry.updatedBy = actorUserId;
  await entry.save({ transaction });

  await registrarAuditoria(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      actorUserId,
      action: 'finance.antifraud.manual_review_cleared',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      beforeJson,
      afterJson: entry.toJSON(),
      reason: reviewNote
        ? `Revisão manual concluída e pagamento liberado: ${reviewNote}`
        : 'Revisão manual concluída — pagamento liberado pelo revisor.',
    },
    transaction
  );

  return entry;
}

module.exports = {
  BANK_ACCOUNT_COOLDOWN_HOURS,
  ANOMALY_HISTORY_MULTIPLIER,
  ANOMALY_NEW_ACCOUNT_THRESHOLD,
  assertBankAccountEligibleForPayment,
  assertNoDuplicatePayment,
  flagAnomalousPayment,
  clearManualReview,
};
