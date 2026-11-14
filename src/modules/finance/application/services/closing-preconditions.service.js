'use strict';

const {
  PeriodClosure,
  PeriodClosureSnapshot,
  FinancialEntry,
} = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { centsOf } = require('./closing-hash');
const { assertValidReferenceMonth, monthBR, getClosureByMonth } = require('./closing-period-guards.service');
const {
  computeThirdPartyState,
  computeCommissionsRepassesState,
  listBankCashEvents,
  computeBankStatementsCheck,
  computeReconciliationPendings,
  computePaymentsInTransit,
} = require('./closing-cash-state.service');

// ---------------------------------------------------------------------------------------------
// F02 (conferência Nayara 18/10/2026) — pré-condições do fechamento (Caderno Financeiro §16:
// "Antes de fechar: extratos importados, pendências de conciliação classificadas, caixa de
// terceiros conferido, comissões/repasses revisados"; Guia §12 "assert ... calculate closing
// snapshot").
//
// Critérios objetivos (2ª rodada, revisor independente 18/10). "Caixa" é contado pela DATA DE
// LIQUIDAÇÃO (settled_at) no fuso de São Paulo, não pela competência: é o dinheiro que passou
// pela conta no mês que tem de estar no extrato e conciliado.
//   BANK_STATEMENTS_IMPORTED  toda conta bancária com movimento de caixa no mês precisa ter uma
//                             importação de extrato cujo período cubra o mês INTEIRO (do dia 1º
//                             ao último dia). Uma transação solta no mês não basta.
//   RECONCILIATION_PENDINGS   nenhuma transação de extrato do mês sem conciliação E nenhum
//                             movimento de caixa bancário do mês (inclusive baixa manual com
//                             comprovante) sem conciliação — os dois lados.
//   CLASSIFICATION_PENDINGS   nenhum excedente PENDING_CLASSIFICATION da competência sem decisão.
//   PAYMENTS_IN_TRANSIT       nenhuma intenção de pagamento enviada ao banco (SUBMITTED/
//                             SUBMITTING) ainda sem resposta para lançamento da competência.
//   THIRD_PARTY_CASH_CHECKED  conferência explícita do caixa de terceiros (quem, quando,
//                             observação) e nada de terceiros mudou desde então — retrato item a
//                             item (id/status/valor), não só o líquido.
//   COMMISSIONS_REPASSES_REVIEWED  revisão explícita de comissões/repasses do mês, e nenhuma
//                             comissão/repasse do mês mudou desde a revisão.
// As duas conferências humanas existem porque o sistema não tem como deduzir sozinho que um
// contador "conferiu" algo — e uma regra automática inventada aqui seria frágil. Ambas guardam um
// retrato do que foi conferido: se o dado mudar depois, a conferência fica desatualizada e o
// fechamento volta a ser bloqueado até nova conferência.
// ---------------------------------------------------------------------------------------------

const CHECK_TYPES = ['THIRD_PARTY_CASH', 'COMMISSIONS_REPASSES'];

// O1 (M45): textos de detalhe exibidos na tela vêm em formato brasileiro (R$ 12.250,00 e
// dd/mm/aaaa hh:mm, horário de Brasília). Os campos numéricos/ISO crus continuam no payload.
function brl(value) {
  return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function brDateTime(date) {
  return new Date(date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * computePeriodPreconditions — avaliação das 5 pré-condições do Caderno §16 para o mês. Não muda
 * nada; é usada pelo endpoint de leitura, por closePeriod (→ REVIEW) e por approvePeriodClosure
 * (→ CLOSED), que reavalia tudo no momento de fechar.
 */
async function computePeriodPreconditions(companyId, referenceMonth, closure, transaction) {
  const cashEvents = await listBankCashEvents(companyId, referenceMonth, transaction);
  const bank = await computeBankStatementsCheck(companyId, referenceMonth, transaction, cashEvents);
  const reconciliation = await computeReconciliationPendings(companyId, referenceMonth, transaction, cashEvents);
  const unreconciled = reconciliation.unreconciledStatementLines + reconciliation.unreconciledEntryIds.length;
  const classificationPendings = await FinancialEntry.count({
    where: { companyId, competenceMonth: referenceMonth, nature: 'PENDING_CLASSIFICATION', status: 'PENDING' },
    transaction,
  });
  const paymentsInTransit = await computePaymentsInTransit(companyId, referenceMonth, transaction);
  const thirdParty = await computeThirdPartyState(companyId, referenceMonth, transaction);
  const commissions = await computeCommissionsRepassesState(companyId, referenceMonth, transaction);

  const thirdPartyChecked = Boolean(closure && closure.thirdPartyCheckedAt);
  // Conferência registrada antes da migration 387 não tem fingerprint: cai na comparação antiga
  // (líquido), que é a única informação gravada naquela época.
  const thirdPartyStale =
    thirdPartyChecked &&
    (closure.thirdPartyFingerprintAtCheck
      ? closure.thirdPartyFingerprintAtCheck !== thirdParty.fingerprint
      : centsOf(closure.thirdPartyBalanceAtCheck) !== centsOf(thirdParty.net));
  const commissionsReviewed = Boolean(closure && closure.commissionsReviewedAt);
  const commissionsStale = commissionsReviewed && closure.commissionsFingerprintAtReview !== commissions.fingerprint;

  const items = [
    {
      code: 'BANK_STATEMENTS_IMPORTED',
      label: 'Extratos bancários importados',
      ok: bank.accountsWithoutStatement.length === 0,
      count: bank.accountsWithoutStatement.length,
      detail:
        bank.accountsWithoutStatement.length === 0
          ? `${bank.accountsWithMovement} conta(s) movimentada(s) no mês, todas com extrato importado.`
          : `${bank.accountsWithoutStatement.length} conta(s) com lançamento liquidado no mês sem extrato importado.`,
      bankAccountIds: bank.accountsWithoutStatement,
    },
    {
      code: 'RECONCILIATION_PENDINGS',
      label: 'Pendências de conciliação classificadas',
      ok: unreconciled === 0,
      count: unreconciled,
      detail:
        unreconciled === 0
          ? 'Todas as transações de extrato do mês e todos os movimentos de caixa bancários do mês estão conciliados.'
          : [
            reconciliation.unreconciledStatementLines > 0
              ? `${reconciliation.unreconciledStatementLines} transação(ões) de extrato do mês sem conciliação`
              : null,
            reconciliation.unreconciledEntryIds.length > 0
              ? `${reconciliation.unreconciledEntryIds.length} lançamento(s) liquidado(s) em conta bancária no mês sem conciliação com o extrato${reconciliation.unreconciledManualSettlements > 0 ? ` (${reconciliation.unreconciledManualSettlements} baixa(s) manual(is) com comprovante)` : ''}`
              : null,
          ].filter(Boolean).join('; ') + '.',
      unreconciledStatementLines: reconciliation.unreconciledStatementLines,
      unreconciledEntryIds: reconciliation.unreconciledEntryIds,
    },
    {
      code: 'CLASSIFICATION_PENDINGS',
      label: 'Excedentes classificados',
      ok: classificationPendings === 0,
      count: classificationPendings,
      detail:
        classificationPendings === 0
          ? 'Nenhum valor excedente aguardando classificação no mês.'
          : `${classificationPendings} valor(es) excedente(s) do mês aguardando classificação.`,
    },
    {
      code: 'PAYMENTS_IN_TRANSIT',
      label: 'Nenhum pagamento em trânsito no banco',
      ok: paymentsInTransit.length === 0,
      count: paymentsInTransit.length,
      detail:
        paymentsInTransit.length === 0
          ? 'Nenhuma intenção de pagamento do mês aguardando resposta do banco.'
          : `${paymentsInTransit.length} pagamento(s) do mês enviado(s) ao banco ainda sem resposta — aguarde a confirmação ou a falha antes de fechar.`,
      paymentIntentIds: paymentsInTransit,
    },
    {
      code: 'THIRD_PARTY_CASH_CHECKED',
      label: 'Caixa de terceiros conferido',
      ok: thirdPartyChecked && !thirdPartyStale,
      count: thirdPartyChecked && !thirdPartyStale ? 0 : 1,
      detail: !thirdPartyChecked
        ? `Conferência ainda não registrada. Saldo de terceiros no fim do mês: ${brl(thirdParty.balanceAtMonthEnd)} (no mês: recebido ${brl(thirdParty.received)}, devolvido ${brl(thirdParty.released)}).`
        : thirdPartyStale
          ? `Lançamentos de terceiros mudaram depois da conferência (saldo conferido ${brl(closure.thirdPartyBalanceAtCheck)}, saldo atual ${brl(thirdParty.balanceAtMonthEnd)}). Confira de novo.`
          : `Conferido em ${brDateTime(closure.thirdPartyCheckedAt)} (saldo de terceiros no fim do mês ${brl(thirdParty.balanceAtMonthEnd)}).`,
      thirdParty,
    },
    {
      code: 'COMMISSIONS_REPASSES_REVIEWED',
      label: 'Comissões e repasses revisados',
      ok: commissionsReviewed && !commissionsStale,
      count: commissionsReviewed && !commissionsStale ? 0 : 1,
      detail: !commissionsReviewed
        ? `Revisão ainda não registrada. Mês com ${commissions.repassesCount} repasse(s) (${commissions.repassesPending} pendente(s)) e ${commissions.commissionInstallmentsCount} parcela(s) de comissão (${commissions.commissionInstallmentsPending} pendente(s)).`
        : commissionsStale
          ? 'Comissões ou repasses do mês mudaram depois da revisão. Revise de novo.'
          : `Revisado em ${brDateTime(closure.commissionsReviewedAt)}.`,
      commissions: {
        repassesCount: commissions.repassesCount,
        repassesPending: commissions.repassesPending,
        commissionInstallmentsCount: commissions.commissionInstallmentsCount,
        commissionInstallmentsPending: commissions.commissionInstallmentsPending,
      },
    },
  ];

  return {
    referenceMonth,
    allOk: items.every((item) => item.ok),
    items,
    thirdParty,
    commissionsFingerprint: commissions.fingerprint,
  };
}

function assertPreconditionsMet(preconditions, stageLabel) {
  if (preconditions.allOk) return;
  const missing = preconditions.items.filter((item) => !item.ok);
  throw AppError.conflict(
    `O período ${monthBR(preconditions.referenceMonth)} não pode ${stageLabel}: ${missing.map((item) => `${item.label} — ${item.detail}`).join(' | ')}`,
    'FINANCE_PERIOD_PRECONDITIONS_NOT_MET',
    { referenceMonth: preconditions.referenceMonth, missing: missing.map((item) => ({ code: item.code, label: item.label, count: item.count, detail: item.detail })) }
  );
}

async function getPeriodPreconditions(payload, transaction) {
  const { companyId } = payload;
  const referenceMonth = assertValidReferenceMonth(payload.referenceMonth);
  if (!companyId) {
    throw AppError.badRequest('O campo "companyId" é obrigatório.', 'FINANCE_PERIOD_VALIDATION');
  }
  const closure = await getClosureByMonth(companyId, referenceMonth, transaction);
  const preconditions = await computePeriodPreconditions(companyId, referenceMonth, closure, transaction);
  const snapshot = closure && closure.currentSnapshotId
    ? await PeriodClosureSnapshot.findByPk(closure.currentSnapshotId, { transaction })
    : null;
  return { closure, status: closure ? closure.status : 'OPEN', preconditions, snapshot };
}

/**
 * confirmPeriodCheck — registra uma das duas conferências humanas do Caderno §16 (caixa de
 * terceiros; comissões/repasses), com quem, quando, observação obrigatória e o retrato do dado
 * conferido. Só antes de pedir o fechamento (período OPEN).
 */
async function confirmPeriodCheck(payload, actorUserId, transaction) {
  const { groupId, companyId } = payload;
  const referenceMonth = assertValidReferenceMonth(payload.referenceMonth);
  const checkType = String(payload.checkType || '').toUpperCase();
  const note = payload.note === undefined || payload.note === null ? '' : String(payload.note).trim();
  if (!groupId || !companyId) {
    throw AppError.badRequest('Os campos "groupId" e "companyId" são obrigatórios.', 'FINANCE_PERIOD_VALIDATION');
  }
  if (!CHECK_TYPES.includes(checkType)) {
    throw AppError.badRequest(`O campo "checkType" deve ser um de: ${CHECK_TYPES.join(', ')}.`, 'FINANCE_PERIOD_VALIDATION');
  }
  if (!note) {
    throw AppError.badRequest(
      'Informe a observação da conferência (o que foi conferido e como) — ela fica registrada no fechamento.',
      'FINANCE_PERIOD_CHECK_NOTE_REQUIRED'
    );
  }

  let closure = await getClosureByMonth(companyId, referenceMonth, transaction, { forUpdate: true });
  if (closure && closure.status !== 'OPEN') {
    throw AppError.conflict(
      `O período ${monthBR(referenceMonth)} está ${closure.status === 'CLOSED' ? 'fechado' : 'em revisão'} — conferências só podem ser registradas com o período aberto${closure.status === 'REVIEW' ? ' (o aprovador pode devolver o período para aberto)' : ''}.`,
      'FINANCE_PERIOD_CHECK_NOT_ALLOWED'
    );
  }
  if (!closure) {
    closure = await PeriodClosure.create(
      { groupId, companyId, referenceMonth, status: 'OPEN', createdBy: actorUserId || null, updatedBy: actorUserId || null },
      { transaction }
    );
  }
  const beforeJson = closure.toJSON();

  if (checkType === 'THIRD_PARTY_CASH') {
    const thirdParty = await computeThirdPartyState(companyId, referenceMonth, transaction);
    closure.thirdPartyCheckedAt = new Date();
    closure.thirdPartyCheckedByUserId = actorUserId || null;
    closure.thirdPartyCheckNote = note;
    closure.thirdPartyBalanceAtCheck = thirdParty.balanceAtMonthEnd;
    closure.thirdPartyFingerprintAtCheck = thirdParty.fingerprint;
  } else {
    const commissions = await computeCommissionsRepassesState(companyId, referenceMonth, transaction);
    closure.commissionsReviewedAt = new Date();
    closure.commissionsReviewedByUserId = actorUserId || null;
    closure.commissionsReviewNote = note;
    closure.commissionsFingerprintAtReview = commissions.fingerprint;
  }
  await closure.save({ transaction });

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: checkType === 'THIRD_PARTY_CASH' ? 'finance.period_closure.third_party_checked' : 'finance.period_closure.commissions_reviewed',
      entityType: 'PeriodClosure',
      entityId: closure.id,
      beforeJson,
      afterJson: closure.toJSON(),
      reason: `${checkType === 'THIRD_PARTY_CASH' ? 'Caixa de terceiros conferido' : 'Comissões e repasses revisados'} para ${referenceMonth}: ${note}`,
    },
    transaction
  );

  return closure;
}

module.exports = {
  CHECK_TYPES,
  computePeriodPreconditions,
  assertPreconditionsMet,
  getPeriodPreconditions,
  confirmPeriodCheck,
};
