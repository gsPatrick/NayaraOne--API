'use strict';

const AppError = require('../../../utils/AppError');
const { localToUtc, isValidZone, STATUS } = require('../../../features/migration-v2/timezone/timezone.convert');

/**
 * Caderno M5 §15 "due_at em timezone correto" (M5-D035 item 4): todo vencimento é interpretado no fuso da empresa
 * (parâmetro `legal.prazos.fuso_horario`, padrão America/Sao_Paulo; legalRules.params.js#legalDeadlineZone).
 *  - Date (ou número em ms): já é um instante, usado como veio.
 *  - "AAAA-MM-DD" (só a data): vence ao fim do dia no fuso da empresa (23:59 local).
 *  - "AAAA-MM-DDTHH:mm[:ss[.SSS]]" (sem fuso): é a hora local do fuso da empresa.
 *  - ISO com deslocamento ou "Z": instante exato, respeitado.
 *  - Data que não existe (31/02, texto) ou horário que não existe no fuso (salto do horário de verão): 400, nunca 500 nem
 *    "rolagem" silenciosa. A conversão usa a base IANA do Node (timezone.convert.js), então fuso com horário de verão
 *    (ou um que volte a ter) é tratado sem deslocamento fixo; horário que ocorre duas vezes vale a primeira ocorrência.
 */
const DEFAULT_ZONE = 'America/Sao_Paulo';
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

function invalid(field) {
  return AppError.badRequest(`O campo "${field}" deve ser uma data válida (AAAA-MM-DD, data e hora no fuso da empresa ou ISO com fuso).`, 'LEGAL_DEADLINE_VALIDATION');
}

function assertCalendarDate(y, m, d, field) {
  const probe = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (probe.getUTCFullYear() !== Number(y) || probe.getUTCMonth() !== Number(m) - 1 || probe.getUTCDate() !== Number(d)) throw invalid(field);
}

function zoneOrDefault(zone) {
  return zone && isValidZone(zone) ? zone : DEFAULT_ZONE;
}

function localInZone(text, zone, field) {
  const out = localToUtc(text, zoneOrDefault(zone));
  if (out.status === STATUS.OK) return new Date(out.utc);
  if (out.status === STATUS.AMBIGUOUS) return new Date(out.first);
  throw invalid(field);
}

function parseDueAt(value, field = 'dueAt', zone = DEFAULT_ZONE) {
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
    return localInZone(`${text}T23:59:00`, zone, field);
  }
  m = text.match(LOCAL_DATE_TIME);
  if (m) {
    assertCalendarDate(m[1], m[2], m[3], field);
    if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] || 0) > 59) throw invalid(field);
    return localInZone(text, zone, field);
  }
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (iso) assertCalendarDate(iso[1], iso[2], iso[3], field);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw invalid(field);
  return parsed;
}

/** "03/11/2026 17:00 (America/Manaus)" ou, no fuso padrão, "(horário de Brasília)", para textos de tarefa e notificação. */
function formatInZone(date, zone = DEFAULT_ZONE) {
  const z = zoneOrDefault(zone);
  const label = z === DEFAULT_ZONE ? 'horário de Brasília' : `fuso ${z}`;
  return `${new Date(date).toLocaleString('pt-BR', { timeZone: z, dateStyle: 'short', timeStyle: 'short' })} (${label})`;
}

const formatSaoPaulo = (date) => formatInZone(date, DEFAULT_ZONE);

module.exports = { parseDueAt, formatInZone, formatSaoPaulo, DEFAULT_ZONE };
