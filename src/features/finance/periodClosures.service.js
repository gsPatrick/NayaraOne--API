'use strict';

const { PeriodClosure } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

// M4-19 — Fechamento mensal com bloqueio de período.
//
// Uma vez que um mês é CLOSED, nenhum lançamento novo pode ser criado nele e nenhum lançamento
// existente daquele mês pode ser editado. Isso é o que dá sentido a "fechamento": o número que
// o contador/o cliente viram no dia do fechamento continua sendo o mesmo amanhã.
//
// Consistente com o ledger imutável (FIN-003/FIN-010): reabrir um período NÃO é uma forma de
// reescrever histórico silenciosamente — exige motivo obrigatório, carimba quem reabriu e
// quando, e registra na trilha de auditoria.

const REFERENCE_MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

function assertValidReferenceMonth(referenceMonth) {
  if (!referenceMonth || !REFERENCE_MONTH_REGEX.test(String(referenceMonth))) {
    throw AppError.badRequest(
      'O campo "referenceMonth" deve estar no formato "YYYY-MM" (ex.: "2026-09").',
      'FINANCE_PERIOD_VALIDATION'
    );
  }
  return String(referenceMonth);
}

/**
 * toReferenceMonth — converte uma data em "YYYY-MM" usando UTC, o mesmo fuso em que `due_at`
 * é persistido — evita que um vencimento no dia 1º ou no último dia do mês caia no mês errado
 * por causa do offset local da máquina que rodou o código.
 */
function toReferenceMonth(date) {
  if (!date) return null;
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function getClosureByMonth(companyId, referenceMonth, transaction) {
  return PeriodClosure.findOne({ where: { companyId, referenceMonth }, transaction });
}

async function isPeriodClosed(companyId, referenceMonth, transaction) {
  if (!referenceMonth) return false;
  const closure = await getClosureByMonth(companyId, referenceMonth, transaction);
  return Boolean(closure && closure.status === 'CLOSED');
}

/**
 * assertPeriodOpenForEntry — guarda usada por financialEntries.service.js. Recebe as datas
 * relevantes do lançamento (vencimento e criação) e recusa a operação se QUALQUER uma delas
 * cair num mês fechado. Um lançamento com vencimento em mês fechado é tão proibido quanto um
 * criado (competência) em mês fechado — ambos alterariam um número já reportado.
 */
async function assertPeriodOpenForEntry(companyId, dates, transaction) {
  const months = new Set(
    (Array.isArray(dates) ? dates : [dates]).map(toReferenceMonth).filter(Boolean)
  );
  for (const month of months) {
    if (await isPeriodClosed(companyId, month, transaction)) {
      throw AppError.conflict(
        `O período ${month} está fechado — nenhum lançamento pode ser criado ou editado nesse mês. Reabra o período (com justificativa) se a correção for mesmo necessária.`,
        'FINANCE_PERIOD_CLOSED',
        { referenceMonth: month }
      );
    }
  }
}

async function listPeriodClosures(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.referenceMonth) where.referenceMonth = filters.referenceMonth;
  return PeriodClosure.findAll({ where, order: [['reference_month', 'DESC']], transaction });
}

async function closePeriod(payload, actorUserId, transaction) {
  const { groupId, companyId } = payload;
  const referenceMonth = assertValidReferenceMonth(payload.referenceMonth);
  if (!groupId || !companyId) {
    throw AppError.badRequest('Os campos "groupId" e "companyId" são obrigatórios.', 'FINANCE_PERIOD_VALIDATION');
  }

  let closure = await getClosureByMonth(companyId, referenceMonth, transaction);
  if (closure && closure.status === 'CLOSED') {
    throw AppError.conflict(`O período ${referenceMonth} já está fechado.`, 'FINANCE_PERIOD_ALREADY_CLOSED');
  }

  const beforeJson = closure ? closure.toJSON() : null;
  if (!closure) {
    closure = await PeriodClosure.create(
      {
        groupId,
        companyId,
        referenceMonth,
        status: 'CLOSED',
        closedAt: new Date(),
        closedByUserId: actorUserId || null,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  } else {
    // Reabertura anterior existe: fechar de novo limpa os carimbos de reabertura (o motivo da
    // reabertura já está preservado na trilha de auditoria — não se perde informação).
    closure.status = 'CLOSED';
    closure.closedAt = new Date();
    closure.closedByUserId = actorUserId || null;
    closure.reopenedAt = null;
    closure.reopenedByUserId = null;
    closure.reopenReason = null;
    closure.updatedBy = actorUserId || null;
    await closure.save({ transaction });
  }

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.period_closure.close',
      entityType: 'PeriodClosure',
      entityId: closure.id,
      beforeJson,
      afterJson: closure.toJSON(),
      reason: `Período ${referenceMonth} fechado — lançamentos desse mês ficam bloqueados para criação/edição.`,
    },
    transaction
  );

  return closure;
}

/**
 * reopenPeriod — motivo é OBRIGATÓRIO. Reabrir um mês fechado é exatamente o tipo de ação que
 * precisa deixar rastro do "por quê", não só do "quem".
 */
async function reopenPeriod(payload, actorUserId, transaction) {
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

  const closure = await getClosureByMonth(companyId, referenceMonth, transaction);
  if (!closure) {
    throw AppError.notFound(`Não há fechamento registrado para o período ${referenceMonth}.`, 'FINANCE_PERIOD_NOT_FOUND');
  }
  if (closure.status !== 'CLOSED') {
    throw AppError.conflict(`O período ${referenceMonth} não está fechado.`, 'FINANCE_PERIOD_NOT_CLOSED');
  }

  const beforeJson = closure.toJSON();
  closure.status = 'OPEN';
  closure.reopenedAt = new Date();
  closure.reopenedByUserId = actorUserId || null;
  closure.reopenReason = String(reason).trim();
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
      reason: `Período ${referenceMonth} REABERTO. Justificativa: ${closure.reopenReason}`,
    },
    transaction
  );

  return closure;
}

module.exports = {
  closePeriod,
  reopenPeriod,
  listPeriodClosures,
  getClosureByMonth,
  isPeriodClosed,
  assertPeriodOpenForEntry,
  toReferenceMonth,
};
