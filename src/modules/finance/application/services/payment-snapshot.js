'use strict';

/**
 * Retrato aprovável da intenção de pagamento (Guia §3 e §4; Caderno §9 "Favorecido e dados bancários usados em payment_intent ficam
 * congelados no snapshot. Qualquer troca de banco/agência/conta/chave PIX/beneficiário invalida toda aprovação anterior").
 *
 * O favorecido é lido da conta de destino do lançamento NO PREPARE e congelado na intenção (beneficiary_snapshot) e no hash. Aprovar,
 * executar e enviar ao banco recalculam o retrato com o lançamento e o favorecido ATUAIS (Guia §5 `approvals.assertSnapshotStillValid`):
 * qualquer diferença recusa. O envio ao banco usa o favorecido congelado, nunca o cadastro do momento.
 */
const AppError = require('../../../../utils/AppError');
const intents = require('../../infrastructure/repositories/payment-intent.repository');
const entries = require('../../infrastructure/repositories/financial-entry.repository');
const domain = require('../../domain/payment-intent');

/** Favorecido atual da conta (dono da conta = pessoa; sem dono, a descrição do lançamento como nome). */
async function loadBeneficiary(bankAccountId, fallbackName, transaction) {
  if (!bankAccountId) return domain.buildBeneficiarySnapshot(null, null, fallbackName);
  const account = await intents.findBankAccount(bankAccountId, transaction);
  if (!account) throw AppError.notFound('Conta bancária de destino não encontrada.', 'FINANCE_BANK_ACCOUNT_NOT_FOUND');
  const owner = account.ownerPersonId ? await entries.findPerson(account.ownerPersonId, transaction) : null;
  return domain.buildBeneficiarySnapshot(account, owner, fallbackName);
}

/** Retrato aprovável com o lançamento e o favorecido de AGORA, para o mesmo valor/parcela da intenção. */
async function currentApprovable(intent, entry, transaction) {
  const beneficiary = await loadBeneficiary(entry.bankAccountId, entry.description, transaction);
  const snapshot = domain.buildApprovableSnapshot(entry, {
    amountCents: domain.toCents(String(intent.snapshotJson.amount)),
    installmentNumber: intent.snapshotJson.installmentNumber,
    beneficiary,
  });
  return { snapshot, hash: domain.computeSnapshotHash(snapshot) };
}

/**
 * assertStillApprovable — Guia §5 assertSnapshotStillValid. Recusa (409) a intenção cujo retrato é anterior à regra do favorecido
 * (FINANCE_PAYMENT_INTENT_SNAPSHOT_OUTDATED) ou cujo lançamento/favorecido mudou depois do PREPARE (FINANCE_PAYMENT_INTENT_STALE, com os
 * campos que mudaram). Devolve o lançamento atual.
 */
async function assertStillApprovable(intent, transaction, verb) {
  if (domain.isLegacySnapshot(intent)) {
    throw AppError.conflict(
      `Esta intenção de pagamento foi preparada antes de o favorecido fazer parte do retrato aprovado: não pode ${verb}. Cancele-a e prepare uma nova.`,
      'FINANCE_PAYMENT_INTENT_SNAPSHOT_OUTDATED'
    );
  }
  const entry = await entries.findById(intent.financialEntryId, transaction);
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  const { snapshot, hash } = await currentApprovable(intent, entry, transaction);
  if (hash !== intent.snapshotHash) {
    const changedFields = domain.changedSnapshotFields(snapshot, intent.snapshotJson);
    const favorecido = changedFields.some((f) => f.startsWith('beneficiary.') || f === 'bankAccountId');
    throw AppError.conflict(
      `${favorecido ? 'O favorecido (conta, agência, banco, chave PIX ou titular) mudou' : 'O lançamento foi alterado'} depois que esta intenção de pagamento ` +
        `foi preparada (campos divergentes: ${changedFields.join(', ') || 'desconhecidos'}) — não é possível ${verb}. Prepare uma nova intenção sobre os dados atuais.`,
      'FINANCE_PAYMENT_INTENT_STALE',
      { expectedHash: intent.snapshotHash, currentHash: hash, changedFields }
    );
  }
  return entry;
}

module.exports = { loadBeneficiary, currentApprovable, assertStillApprovable };
