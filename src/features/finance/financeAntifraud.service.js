'use strict';

const AppError = require('../../utils/AppError');
const { BankAccount } = require('../../models');

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

module.exports = {
  BANK_ACCOUNT_COOLDOWN_HOURS,
  assertBankAccountEligibleForPayment,
  assertNoDuplicatePayment,
};
