'use strict';

const { PeriodClosure } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { publishPeriodClosed } = require('./finance-events.service');
const {
  assertValidReferenceMonth,
  toReferenceMonth,
  monthBR,
  getClosureByMonth,
  isPeriodClosed,
  assertPeriodOpenForEntry,
  assertCompetenceOpen,
} = require('./closing-period-guards.service');
const {
  CHECK_TYPES,
  computePeriodPreconditions,
  assertPreconditionsMet,
  getPeriodPreconditions,
  confirmPeriodCheck,
} = require('./closing-preconditions.service');
const { buildClosingSnapshot, verifySnapshotIntegrity } = require('./closing-snapshot.service');

// M4-19 — Fechamento mensal com bloqueio de período.
//
// Uma vez que um mês é CLOSED, nenhum lançamento novo pode ser criado nele e nenhum lançamento
// existente daquele mês pode ser editado. Isso é o que dá sentido a "fechamento": o número que
// o contador/o cliente viram no dia do fechamento continua sendo o mesmo amanhã.
//
// Consistente com o ledger imutável (FIN-003/FIN-010): reabrir um período NÃO é uma forma de
// reescrever histórico silenciosamente — exige motivo obrigatório, carimba quem reabriu e
// quando, e registra na trilha de auditoria.

// Organização: guardas de período/competência em closing-period-guards.service.js; pré-condições
// e conferências em closing-preconditions.service.js (leituras do mês em
// closing-cash-state.service.js); retrato e hash em closing-snapshot.service.js. Aqui ficam o
// ciclo OPEN → REVIEW → CLOSED, a devolução, a reabertura e a listagem.

async function listPeriodClosures(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.referenceMonth) where.referenceMonth = filters.referenceMonth;
  return PeriodClosure.findAll({ where, order: [['reference_month', 'DESC']], transaction });
}

/**
 * closePeriod — ACHADO REAL CORRIGIDO (auditoria independente Nayara, 14/10/2026, A06): esta
 * função pulava direto pra CLOSED, sem nenhuma etapa de REVIEW/revisão antes (o Caderno, páginas
 * 121/128, pede OPEN → REVIEW → CLOSED). Agora ela só leva o período pra REVIEW — "fechamento
 * solicitado, pendente de aprovação" — nunca fecha de verdade sozinha. Só `approvePeriodClosure`
 * (ação separada, com permissão + MFA de step-up) move REVIEW → CLOSED.
 */
async function closePeriod(payload, actorUserId, transaction) {
  const { groupId, companyId } = payload;
  const referenceMonth = assertValidReferenceMonth(payload.referenceMonth);
  if (!groupId || !companyId) {
    throw AppError.badRequest('Os campos "groupId" e "companyId" são obrigatórios.', 'FINANCE_PERIOD_VALIDATION');
  }

  let closure = await getClosureByMonth(companyId, referenceMonth, transaction, { forUpdate: true });
  if (closure && closure.status === 'CLOSED') {
    throw AppError.conflict(`O período ${monthBR(referenceMonth)} já está fechado.`, 'FINANCE_PERIOD_ALREADY_CLOSED');
  }
  if (closure && closure.status === 'REVIEW') {
    throw AppError.conflict(`O período ${monthBR(referenceMonth)} já está em revisão, aguardando aprovação do fechamento.`, 'FINANCE_PERIOD_ALREADY_IN_REVIEW');
  }

  // F02 — Caderno §16: nada vai para revisão de fechamento com pré-condição pendente.
  const preconditions = await computePeriodPreconditions(companyId, referenceMonth, closure, transaction);
  assertPreconditionsMet(preconditions, 'ir para revisão de fechamento');

  const beforeJson = closure ? closure.toJSON() : null;
  if (!closure) {
    closure = await PeriodClosure.create(
      {
        groupId,
        companyId,
        referenceMonth,
        status: 'REVIEW',
        reviewRequestedByUserId: actorUserId || null,
        reviewRequestedAt: new Date(),
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  } else {
    // Reabertura anterior existe: solicitar fechamento de novo limpa os carimbos de reabertura
    // (o motivo da reabertura já está preservado na trilha de auditoria — não se perde informação).
    closure.status = 'REVIEW';
    closure.reopenedAt = null;
    closure.reopenedByUserId = null;
    closure.reopenReason = null;
    closure.reviewRequestedByUserId = actorUserId || null;
    closure.reviewRequestedAt = new Date();
    closure.updatedBy = actorUserId || null;
    await closure.save({ transaction });
  }

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.period_closure.request_review',
      entityType: 'PeriodClosure',
      entityId: closure.id,
      beforeJson,
      afterJson: closure.toJSON(),
      reason: `Fechamento do período ${monthBR(referenceMonth)} solicitado — em revisão, ainda não bloqueado. Aguardando aprovação.`,
    },
    transaction
  );

  return closure;
}

/**
 * approvePeriodClosure — único caminho que move REVIEW → CLOSED de verdade, bloqueando o período.
 * Exige um ator DIFERENTE de quem solicitou o fechamento (mesmo princípio de segregação já usado
 * em outros gates desta sessão — Compras, Ajuste de inventário, Perdas, Requisição de material).
 */
async function approvePeriodClosure(payload, actorUserId, transaction) {
  const { companyId } = payload;
  const referenceMonth = assertValidReferenceMonth(payload.referenceMonth);
  if (!companyId) {
    throw AppError.badRequest('O campo "companyId" é obrigatório.', 'FINANCE_PERIOD_VALIDATION');
  }

  // FOR UPDATE: duas aprovações simultâneas do mesmo mês são serializadas — a segunda espera a
  // primeira e reavalia o status (já CLOSED), em vez de gravar um segundo snapshot.
  const closure = await getClosureByMonth(companyId, referenceMonth, transaction, { forUpdate: true });
  if (!closure) {
    throw AppError.notFound(`Não há solicitação de fechamento para o período ${monthBR(referenceMonth)}.`, 'FINANCE_PERIOD_NOT_FOUND');
  }
  if (closure.status !== 'REVIEW') {
    throw AppError.conflict(`O período ${monthBR(referenceMonth)} não está aguardando aprovação de fechamento.`, 'FINANCE_PERIOD_NOT_IN_REVIEW');
  }
  const requesterId = closure.reviewRequestedByUserId || closure.updatedBy;
  if (actorUserId && requesterId && String(actorUserId) === String(requesterId)) {
    throw AppError.forbidden(
      'Quem solicitou o fechamento deste período não pode ser quem aprova — peça para outra pessoa confirmar.',
      'FINANCE_PERIOD_SELF_APPROVAL_BLOCKED'
    );
  }
  // Segregação nas conferências (decisão documentada): o Caderno §16 exige as conferências e a
  // aprovação, sem dizer quem confere. Exigir que quem PEDE o fechamento não confira travaria a
  // operação de equipes pequenas sem ganho de controle; o controle efetivo é que quem APROVA não
  // tenha conferido nada — assim o mês nunca fecha só com a palavra de quem certificou o caixa.
  const checkers = [closure.thirdPartyCheckedByUserId, closure.commissionsReviewedByUserId].filter(Boolean).map(String);
  if (actorUserId && checkers.includes(String(actorUserId))) {
    throw AppError.forbidden(
      'Quem registrou uma das conferências do mês (caixa de terceiros ou comissões/repasses) não pode ser quem aprova o fechamento — a aprovação tem de vir de outra pessoa.',
      'FINANCE_PERIOD_CHECKER_APPROVAL_BLOCKED'
    );
  }

  // F02 — reavalia TODAS as pré-condições no momento de fechar (algo pode ter mudado desde o
  // pedido de revisão: transação de extrato nova, comissão alterada, movimento de terceiros).
  const preconditions = await computePeriodPreconditions(companyId, referenceMonth, closure, transaction);
  assertPreconditionsMet(preconditions, 'ser fechado');

  const beforeJson = closure.toJSON();
  const snapshot = await buildClosingSnapshot(closure, preconditions, actorUserId, transaction);
  closure.status = 'CLOSED';
  closure.closedAt = new Date();
  closure.closedByUserId = actorUserId || null;
  closure.currentSnapshotId = snapshot.id;
  closure.updatedBy = actorUserId || null;
  await closure.save({ transaction });

  await publishPeriodClosed(closure, snapshot, transaction);

  await registrarAuditoria(
    {
      groupId: closure.groupId,
      companyId: closure.companyId,
      actorUserId,
      action: 'finance.period_closure.close',
      entityType: 'PeriodClosure',
      entityId: closure.id,
      beforeJson,
      afterJson: { closure: closure.toJSON(), snapshotId: snapshot.id, snapshotHash: snapshot.snapshotHash },
      reason: `Período ${referenceMonth} fechado com as 5 pré-condições do Caderno §16 atendidas — snapshot ${snapshot.snapshotHash.slice(0, 12)} gravado; lançamentos desse mês ficam bloqueados para criação/edição.`,
    },
    transaction
  );

  return closure;
}

/**
 * applyPeriodReopen — efetiva a reabertura de um mês fechado. Só é chamada pelo fluxo CRITICAL de period-reopen.service.js (Caderno §16
 * "Reabertura requer permissão CRITICAL, MFA, motivo e auditoria"; Guia §18 "Não reabrir fechamento sem fluxo CRITICAL"): o pedido de uma
 * pessoa e a aprovação de outra, as duas com finance:periodReopen e MFA recente. `actorUserId` é quem aprovou; `context.requestedByUserId`
 * e `context.approvalRequestId` ficam na auditoria.
 */
async function applyPeriodReopen(payload, actorUserId, transaction, context = {}) {
  const { companyId, reason } = payload;
  const referenceMonth = assertValidReferenceMonth(payload.referenceMonth);
  if (!companyId) {
    throw AppError.badRequest('O campo "companyId" é obrigatório.', 'FINANCE_PERIOD_VALIDATION');
  }
  if (!reason || !String(reason).trim()) {
    throw AppError.badRequest(
      'O campo "reason" é obrigatório para reabrir um período fechado (justificativa auditável).',
      'FINANCE_PERIOD_REOPEN_REASON_REQUIRED'
    );
  }

  const closure = await getClosureByMonth(companyId, referenceMonth, transaction, { forUpdate: true });
  if (!closure) {
    throw AppError.notFound(`Não há fechamento registrado para o período ${monthBR(referenceMonth)}.`, 'FINANCE_PERIOD_NOT_FOUND');
  }
  if (closure.status !== 'CLOSED') {
    throw AppError.conflict(`O período ${monthBR(referenceMonth)} não está fechado.`, 'FINANCE_PERIOD_NOT_CLOSED');
  }

  const beforeJson = closure.toJSON();
  closure.status = 'OPEN';
  closure.reopenedAt = new Date();
  closure.reopenedByUserId = actorUserId || null;
  closure.reopenReason = String(reason).trim();
  // F02 — reabrir invalida as conferências (o mês vai mudar); fechar de novo exige conferir de
  // novo e gera um snapshot NOVO. O snapshot anterior fica preservado em
  // period_closure_snapshots (imutável) como histórico.
  closure.thirdPartyCheckedAt = null;
  closure.thirdPartyCheckedByUserId = null;
  closure.thirdPartyCheckNote = null;
  closure.thirdPartyBalanceAtCheck = null;
  closure.thirdPartyFingerprintAtCheck = null;
  closure.reviewRequestedByUserId = null;
  closure.reviewRequestedAt = null;
  closure.commissionsReviewedAt = null;
  closure.commissionsReviewedByUserId = null;
  closure.commissionsReviewNote = null;
  closure.commissionsFingerprintAtReview = null;
  closure.currentSnapshotId = null;
  closure.updatedBy = actorUserId || null;
  await closure.save({ transaction });

  await registrarAuditoria(
    {
      groupId: closure.groupId,
      companyId: closure.companyId,
      actorUserId,
      action: 'finance.period_closure.reopen',
      entityType: 'PeriodClosure',
      entityId: closure.id,
      beforeJson,
      afterJson: closure.toJSON(),
      reason: `Período ${referenceMonth} REABERTO pelo fluxo CRITICAL (pedido de ${context.requestedByUserId || '-'}, aprovado por ${actorUserId}, aprovação ${context.approvalRequestId || '-'}). Justificativa: ${closure.reopenReason}`,
    },
    transaction
  );

  return closure;
}

/**
 * returnPeriodToOpen — F02 (2ª rodada): saída controlada de REVIEW para OPEN. Antes não existia:
 * se algo mudava no mês depois do pedido (conferência desatualizada), a aprovação falhava, a
 * conferência não podia ser refeita (só em OPEN), o pedido não podia ser refeito (já em REVIEW) e
 * a reabertura só vale para CLOSED — o período ficava preso. Exige motivo; fica na auditoria.
 * As conferências são mantidas: se o dado mudou, elas aparecem desatualizadas e precisam ser
 * refeitas antes de pedir o fechamento de novo (o pedido novo reinicia a segregação).
 */
async function returnPeriodToOpen(payload, actorUserId, transaction) {
  const { companyId, reason } = payload;
  const referenceMonth = assertValidReferenceMonth(payload.referenceMonth);
  if (!companyId) {
    throw AppError.badRequest('O campo "companyId" é obrigatório.', 'FINANCE_PERIOD_VALIDATION');
  }
  if (!reason || !String(reason).trim()) {
    throw AppError.badRequest(
      'O campo "reason" é obrigatório para devolver o período para aberto (o que precisa ser corrigido).',
      'FINANCE_PERIOD_RETURN_REASON_REQUIRED'
    );
  }
  const closure = await getClosureByMonth(companyId, referenceMonth, transaction, { forUpdate: true });
  if (!closure) {
    throw AppError.notFound(`Não há solicitação de fechamento para o período ${monthBR(referenceMonth)}.`, 'FINANCE_PERIOD_NOT_FOUND');
  }
  if (closure.status !== 'REVIEW') {
    throw AppError.conflict(
      `O período ${monthBR(referenceMonth)} não está em revisão — só um pedido de fechamento em revisão pode voltar para aberto.`,
      'FINANCE_PERIOD_NOT_IN_REVIEW'
    );
  }

  const beforeJson = closure.toJSON();
  closure.status = 'OPEN';
  closure.returnedToOpenAt = new Date();
  closure.returnedToOpenByUserId = actorUserId || null;
  closure.returnToOpenReason = String(reason).trim();
  closure.reviewRequestedByUserId = null;
  closure.reviewRequestedAt = null;
  closure.updatedBy = actorUserId || null;
  await closure.save({ transaction });

  await registrarAuditoria(
    {
      groupId: closure.groupId,
      companyId: closure.companyId,
      actorUserId,
      action: 'finance.period_closure.return_to_open',
      entityType: 'PeriodClosure',
      entityId: closure.id,
      beforeJson,
      afterJson: closure.toJSON(),
      reason: `Pedido de fechamento de ${referenceMonth} devolvido para aberto. Motivo: ${closure.returnToOpenReason}`,
    },
    transaction
  );

  return closure;
}

module.exports = {
  closePeriod,
  returnPeriodToOpen,
  assertCompetenceOpen,
  approvePeriodClosure,
  applyPeriodReopen,
  // Reabrir é sempre o PEDIDO do fluxo CRITICAL (duas pessoas): ninguém reabre sozinho por este nome.
  reopenPeriod: (...args) => require('./period-reopen.service').requestPeriodReopen(...args),
  listPeriodClosures,
  getPeriodPreconditions,
  computePeriodPreconditions,
  confirmPeriodCheck,
  verifySnapshotIntegrity,
  CHECK_TYPES,
  getClosureByMonth,
  isPeriodClosed,
  assertPeriodOpenForEntry,
  toReferenceMonth,
};
