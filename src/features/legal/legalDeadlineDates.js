'use strict';

const AppError = require('../../utils/AppError');

/**
 * Caderno M5 §15 "due_at em timezone correto" (M5-D035 item 4): todo vencimento é interpretado no fuso de São Paulo.
 *  - Date (ou número em ms): já é um instante, usado como veio.
 *  - "AAAA-MM-DD" (só a data): vence ao fim do dia em São Paulo (23:59, horário de Brasília).
 *  - "AAAA-MM-DDTHH:mm[:ss[.SSS]]" (sem fuso): é a hora local de São Paulo.
 *  - ISO com deslocamento ou "Z": instante exato, respeitado.
 *  - Data que não existe (31/02, texto): 400, nunca 500 nem "rolagem" silenciosa para o mês seguinte.
 * America/Sao_Paulo está em UTC-3 o ano todo desde o fim do horário de verão (Decreto 9.772/2019); o deslocamento
 * fixo -03:00 é o do fuso (DECISÃO registrada: se o horário de verão voltar, este é o único ponto a mudar).
 */
const SAO_PAULO_OFFSET = '-03:00';
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

function invalid(field) {
  return AppError.badRequest(`O campo "${field}" deve ser uma data válida (AAAA-MM-DD, data e hora de São Paulo ou ISO com fuso).`, 'LEGAL_DEADLINE_VALIDATION');
}

function assertCalendarDate(y, m, d, field) {
  const probe = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (probe.getUTCFullYear() !== Number(y) || probe.getUTCMonth() !== Number(m) - 1 || probe.getUTCDate() !== Number(d)) throw invalid(field);
}

function parseDueAt(value, field = 'dueAt') {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw invalid(field);
    return value;
  }
  if (typeof value === 'number') {
    const asDate = new Date(value);
    if (Number.isNaN(asDate.getTime())) throw invalid(field);
    return asDate;
  }
  if (typeof value !== 'string' || !value.trim()) throw invalid(field);
  const text = value.trim();
  let m = text.match(DATE_ONLY);
  if (m) {
    assertCalendarDate(m[1], m[2], m[3], field);
    return new Date(`${text}T23:59:00${SAO_PAULO_OFFSET}`);
  }
  m = text.match(LOCAL_DATE_TIME);
  if (m) {
    assertCalendarDate(m[1], m[2], m[3], field);
    if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] || 0) > 59) throw invalid(field);
    return new Date(`${text}${SAO_PAULO_OFFSET}`);
  }
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (iso) assertCalendarDate(iso[1], iso[2], iso[3], field);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw invalid(field);
  return parsed;
}

/** "03/11/2026 17:00 (horário de Brasília)" para textos de tarefa e notificação. */
function formatSaoPaulo(date) {
  return `${new Date(date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })} (horário de Brasília)`;
}

module.exports = { parseDueAt, formatSaoPaulo, SAO_PAULO_OFFSET };
