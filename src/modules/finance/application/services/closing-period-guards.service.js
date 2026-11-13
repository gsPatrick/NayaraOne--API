'use strict';

// Guardas de período/competência do fechamento mensal (M4-19), usadas pelos demais serviços do
// Financeiro por meio de closing.service.js, e utilitários de mês de referência.

const { formatCompetenceBR } = require('../../../../utils/formatBR');

const { PeriodClosure } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { businessDateKey } = require('../../../../utils/businessDate');

const REFERENCE_MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

function assertValidReferenceMonth(referenceMonth) {
  if (!referenceMonth || !REFERENCE_MONTH_REGEX.test(String(referenceMonth))) {
    throw AppError.badRequest(
      'O mês de referência precisa estar no formato mês/ano (ex.: 09/2026).',
      'FINANCE_PERIOD_VALIDATION'
    );
  }
  return String(referenceMonth);
}

/**
 * toReferenceMonth — "YYYY-MM" de um valor:
 *   - "YYYY-MM" (competência) volta como está;
 *   - "YYYY-MM-DD" (data de calendário) usa o próprio mês, sem conversão de fuso;
 *   - instante (Date/ISO) é convertido para o dia em São Paulo antes de tirar o mês.
 * F02 (2ª rodada): antes usava UTC, e um instante às 22h do dia 31 em Brasília (01h UTC do dia
 * 1º) caía no mês seguinte.
 */
function toReferenceMonth(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (REFERENCE_MONTH_REGEX.test(trimmed)) return trimmed;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed.slice(0, 7);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return businessDateKey(parsed).slice(0, 7);
}

/** monthBR — "2071-05" -> "05/2071" (formato que o usuário vê nas mensagens). */
function monthBR(value) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(value || ''));
  return m ? `${m[2]}/${m[1]}` : String(value || '');
}

async function getClosureByMonth(companyId, referenceMonth, transaction, { forUpdate = false } = {}) {
  return PeriodClosure.findOne({
    where: { companyId, referenceMonth },
    transaction,
    ...(forUpdate && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });
}

async function isPeriodClosed(companyId, referenceMonth, transaction) {
  if (!referenceMonth) return false;
  const closure = await getClosureByMonth(companyId, referenceMonth, transaction);
  return Boolean(closure && closure.status === 'CLOSED');
}

/**
 * assertPeriodOpenForEntry — guarda usada por financial-entry.service.js, receipt.service.js e competence-guard.js. Recebe as datas
 * relevantes do lançamento (vencimento, criação e/ou a própria competência "YYYY-MM") e recusa a
 * operação se QUALQUER uma delas cair num mês CLOSED. Só CLOSED bloqueia aqui: durante REVIEW o
 * caixa continua andando (baixa, confirmação do banco); o que muda o número em revisão vira
 * conferência desatualizada e o aprovador devolve o período para OPEN (returnPeriodToOpen).
 * Para mudança de COMPETÊNCIA use assertCompetenceOpen, que bloqueia CLOSED e REVIEW.
 */
async function assertPeriodOpenForEntry(companyId, dates, transaction) {
  const months = new Set(
    (Array.isArray(dates) ? dates : [dates]).map(toReferenceMonth).filter(Boolean)
  );
  for (const month of months) {
    if (await isPeriodClosed(companyId, month, transaction)) {
      throw AppError.conflict(
        `O período ${monthBR(month)} está fechado — nenhum lançamento pode ser criado ou editado nesse mês. Reabra o período (com justificativa) se a correção for mesmo necessária.`,
        'FINANCE_PERIOD_CLOSED',
        { referenceMonth: month }
      );
    }
  }
}

/**
 * assertCompetenceOpen — F02 (2ª rodada; Caderno §16: "CLOSED bloqueia alteração comum de
 * competência"). Guarda de COMPETÊNCIA: recusa criar um lançamento com competência num mês
 * fechado, mover um lançamento PARA um mês fechado e TIRAR um lançamento de um mês fechado
 * (quem chama passa a competência atual e a nova). Também bloqueia mês em REVIEW: o que está
 * em revisão é o retrato que vai ser aprovado — se algo precisa entrar ou sair da competência,
 * o aprovador devolve o período para OPEN (returnPeriodToOpen) com motivo.
 *
 * Assinatura: assertCompetenceOpen(companyId, competenceMonths, transaction)
 *   competenceMonths: string "YYYY-MM" ou array delas (null/undefined/'' são ignorados; valores
 *   repetidos são conferidos uma vez). Lança AppError 409 FINANCE_PERIOD_CLOSED (CLOSED) ou
 *   FINANCE_PERIOD_IN_REVIEW (REVIEW), com details { referenceMonth }; 400
 *   FINANCE_PERIOD_VALIDATION se algum valor não for "YYYY-MM".
 */
async function assertCompetenceOpen(companyId, competenceMonths, transaction) {
  const values = (Array.isArray(competenceMonths) ? competenceMonths : [competenceMonths])
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== '')
    .map((value) => assertValidReferenceMonth(String(value).trim()));
  for (const month of new Set(values)) {
    const closure = await getClosureByMonth(companyId, month, transaction);
    if (closure && closure.status === 'CLOSED') {
      throw AppError.conflict(
        `A competência ${formatCompetenceBR(month)} está fechada — nenhum lançamento pode entrar nela ou sair dela. Reabra o período (com justificativa) se a correção for mesmo necessária, ou lance o ajuste no período corrente com referência a ${formatCompetenceBR(month)}.`,
        'FINANCE_PERIOD_CLOSED',
        { referenceMonth: month }
      );
    }
    if (closure && closure.status === 'REVIEW') {
      throw AppError.conflict(
        `A competência ${formatCompetenceBR(month)} está em revisão de fechamento — nada pode entrar nela ou sair dela enquanto o retrato do mês é aprovado. Peça ao aprovador para devolver o período para aberto.`,
        'FINANCE_PERIOD_IN_REVIEW',
        { referenceMonth: month }
      );
    }
  }
}

module.exports = {
  assertValidReferenceMonth,
  toReferenceMonth,
  monthBR,
  getClosureByMonth,
  isPeriodClosed,
  assertPeriodOpenForEntry,
  assertCompetenceOpen,
};
