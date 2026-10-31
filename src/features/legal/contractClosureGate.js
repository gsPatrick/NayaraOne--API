'use strict';

const { Op } = require('sequelize');
const AppError = require('../../utils/AppError');

/**
 * contractClosureGate.js — GATE ÚNICO de encerramento/rescisão de contrato (Frente 5, Marco 5;
 * conferência 18/10/2026 item 8).
 *
 * Antes existiam DOIS gates diferentes e incompletos:
 *   - terminateContract/closeContract (contracts.service.js): só garantia ACTIVE e processo
 *     aberto — e closeContract não checava nada;
 *   - checkCloseoutEligibility (billing/closeout.service.js): só cobrança e utilidades;
 *   - e a transição genérica POST /legal/contracts/:id/transition aceitava ACTIVE -> TERMINATED
 *     e TERMINATED -> CLOSED SEM NENHUM dos dois.
 *
 * Agora TODO caminho que encerra/rescinde contrato (terminate, close, transition genérica com
 * alvo TERMINATED/CLOSED, closeout financeiro) chama `assertContractClosureAllowed`, que usa
 * `collectContractClosurePendencies` — uma lista só, fail closed: qualquer pendência bloqueia.
 */

// Notificação formal ainda "em curso" (não entregue nem rejeitada) segura o encerramento.
const NOTICE_OPEN_STATUSES = ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'SENT'];
// Prazo jurídico concluído/cancelado não segura; qualquer outro status segura.
const DEADLINE_CLOSED_STATUSES = ['DONE', 'CANCELLED'];

const CLOSURE_TARGET_STATUSES = ['TERMINATED', 'CLOSED'];

async function collectContractClosurePendencies(contractId, transaction) {
  // require lazy: models/index carrega tudo; evita ciclo com contracts.service.js.
  const {
    BillingSchedule, CollectionCase, UtilityObligation, OwnershipTransferTask,
    Guarantee, LegalCase, LegalDeadline, Notice, FinancialEntry,
  } = require('../../models');
  const pendencies = [];

  const openBilling = await BillingSchedule.findAll({
    where: { contractId, status: { [Op.in]: ['OPEN', 'PARTIALLY_PAID'] } },
    transaction,
  });
  if (openBilling.length > 0) {
    pendencies.push({
      type: 'OPEN_BILLING',
      detail: `${openBilling.length} competência(s) de cobrança ainda em aberto.`,
      billingScheduleIds: openBilling.map((b) => b.id),
    });
  }

  const openCollection = await CollectionCase.findAll({
    where: { contractId, status: { [Op.ne]: 'RESOLVED' } },
    transaction,
  });
  if (openCollection.length > 0) {
    pendencies.push({
      type: 'OPEN_COLLECTION_CASE',
      detail: `${openCollection.length} caso(s) de cobrança ainda não resolvido(s).`,
      collectionCaseIds: openCollection.map((c) => c.id),
    });
  }

  const obligations = await UtilityObligation.findAll({ where: { contractId }, transaction });
  if (obligations.length > 0) {
    const pendingTransfers = await OwnershipTransferTask.findAll({
      where: { utilityObligationId: { [Op.in]: obligations.map((o) => o.id) }, status: 'PENDING' },
      transaction,
    });
    if (pendingTransfers.length > 0) {
      pendencies.push({
        type: 'PENDING_UTILITY_TRANSFER',
        detail: `${pendingTransfers.length} transferência(s) de titularidade de utilidade não concluída(s).`,
        ownershipTransferTaskIds: pendingTransfers.map((t) => t.id),
      });
    }
  }

  const activeGuarantees = await Guarantee.findAll({ where: { contractId, status: 'ACTIVE' }, transaction });
  if (activeGuarantees.length > 0) {
    pendencies.push({
      type: 'ACTIVE_GUARANTEE',
      detail: `${activeGuarantees.length} garantia(s) ainda ativa(s) (não devolvida(s)/liberada(s)).`,
      guaranteeIds: activeGuarantees.map((g) => g.id),
    });
  }

  // Saldo de caução: dinheiro de terceiro recebido no contrato que ainda não foi devolvido nem
  // compensado. Mesma conta do Financeiro (computeThirdPartyOriginBalance) — sem fórmula paralela.
  const depositOrigins = await FinancialEntry.findAll({
    where: {
      contractId,
      isThirdPartyFunds: true,
      nature: 'RECEIVABLE',
      parentEntryId: null,
      status: { [Op.notIn]: ['REVERSED', 'CANCELLED'] },
    },
    transaction,
  });
  if (depositOrigins.length > 0) {
    const { computeThirdPartyOriginBalance } = require('../finance/financialEntries.service');
    const withBalance = [];
    for (const origin of depositOrigins) {
      const balance = await computeThirdPartyOriginBalance(origin, transaction);
      if (Number(balance.available) > 0) withBalance.push({ originEntryId: origin.id, available: balance.available });
    }
    if (withBalance.length > 0) {
      pendencies.push({
        type: 'DEPOSIT_BALANCE',
        detail: `${withBalance.length} caução(ões) com saldo ainda não devolvido/compensado.`,
        deposits: withBalance,
      });
    }
  }

  const cases = await LegalCase.findAll({ where: { contractId }, transaction });
  const openCases = cases.filter((c) => c.status !== 'CLOSED');
  if (openCases.length > 0) {
    pendencies.push({
      type: 'OPEN_LEGAL_CASE',
      detail: `${openCases.length} processo(s) jurídico(s) vinculado(s) ainda não encerrado(s).`,
      legalCaseIds: openCases.map((c) => c.id),
    });
  }

  // Prazos: os do processo do contrato (inclusive de processo já CLOSED — prazo esquecido aberto
  // continua sendo pendência).
  if (cases.length > 0) {
    const openDeadlines = await LegalDeadline.findAll({
      where: { legalCaseId: { [Op.in]: cases.map((c) => c.id) }, status: { [Op.notIn]: DEADLINE_CLOSED_STATUSES } },
      transaction,
    });
    if (openDeadlines.length > 0) {
      pendencies.push({
        type: 'OPEN_LEGAL_DEADLINE',
        detail: `${openDeadlines.length} prazo(s) jurídico(s) ainda não concluído(s).`,
        legalDeadlineIds: openDeadlines.map((d) => d.id),
      });
    }
  }

  const noticeWhere = cases.length > 0
    ? { [Op.or]: [{ contractId }, { legalCaseId: { [Op.in]: cases.map((c) => c.id) } }], status: { [Op.in]: NOTICE_OPEN_STATUSES } }
    : { contractId, status: { [Op.in]: NOTICE_OPEN_STATUSES } };
  const openNotices = await Notice.findAll({ where: noticeWhere, transaction });
  if (openNotices.length > 0) {
    pendencies.push({
      type: 'OPEN_NOTICE',
      detail: `${openNotices.length} notificação(ões) formal(is) ainda não entregue(s) nem rejeitada(s).`,
      noticeIds: openNotices.map((n) => n.id),
    });
  }

  return pendencies;
}

/**
 * assertContractClosureAllowed — a ÚNICA função que decide se um contrato pode ser encerrado.
 * Lança 409 LEGAL_CONTRACT_CLOSURE_BLOCKED com a lista completa de pendências em `details`.
 */
// O4 (auditoria M45): a mensagem mostrava o código cru ("OPEN_BILLING"). `type` segue em details.
const PENDENCY_LABELS = {
  OPEN_BILLING: 'cobrança em aberto',
  OPEN_COLLECTION_CASE: 'caso de cobrança aberto',
  PENDING_UTILITY_TRANSFER: 'transferência de consumo (água/luz/gás) pendente',
  ACTIVE_GUARANTEE: 'garantia ainda ativa',
  DEPOSIT_BALANCE: 'saldo de caução a devolver',
  OPEN_LEGAL_CASE: 'processo jurídico aberto',
  OPEN_LEGAL_DEADLINE: 'prazo jurídico em aberto',
  OPEN_NOTICE: 'notificação em aberto',
};

async function assertContractClosureAllowed(contractId, transaction) {
  const pendencies = await collectContractClosurePendencies(contractId, transaction);
  if (pendencies.length > 0) {
    throw AppError.conflict(
      `Não é possível encerrar o contrato: ${pendencies.length} pendência(s) — ${[...new Set(pendencies.map((p) => PENDENCY_LABELS[p.type] || p.type))].join(', ')}.`,
      'LEGAL_CONTRACT_CLOSURE_BLOCKED',
      { pendencies }
    );
  }
  return true;
}

module.exports = {
  PENDENCY_LABELS,
  collectContractClosurePendencies,
  assertContractClosureAllowed,
  CLOSURE_TARGET_STATUSES,
  NOTICE_OPEN_STATUSES,
  DEADLINE_CLOSED_STATUSES,
};
