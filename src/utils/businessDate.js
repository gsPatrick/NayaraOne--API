'use strict';

// Datas de negócio no fuso America/Sao_Paulo (UTC-3 fixo, sem horário de verão desde 2019).
// Vencimento de lançamento é DATA de calendário: um lançamento que vence hoje não está vencido
// em nenhum horário de hoje — só a partir de 00:00 de amanhã em São Paulo. Comparar o instante
// `dueAt` com "agora" erra porque datas puras são gravadas ao meio-dia de São Paulo
// (insurance.service.js#dateOnlyToNoonSaoPauloInstant / Front lib/format.js#dateOnlyInputToIso):
// depois do meio-dia do próprio dia de vencimento, `dueAt < agora` já era verdade.

const BUSINESS_TIMEZONE = 'America/Sao_Paulo';
const SAO_PAULO_UTC_OFFSET_HOURS = 3;

function businessDateKey(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
}

function startOfBusinessDay(now = new Date(), addDays = 0) {
  const [year, month, day] = businessDateKey(now).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + addDays, SAO_PAULO_UTC_OFFSET_HOURS, 0, 0, 0));
}

function isDueDateOverdue(dueAt, now = new Date()) {
  if (!dueAt) return false;
  return new Date(dueAt).getTime() < startOfBusinessDay(now).getTime();
}

module.exports = { BUSINESS_TIMEZONE, businessDateKey, startOfBusinessDay, isDueDateOverdue };
