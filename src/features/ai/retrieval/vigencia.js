'use strict';

/**
 * Vigência das fontes do RAG (M9-D024). Uma fonte vale em `agora` se `status = ACTIVE`, `effective_from <= agora` e
 * (`effective_until` nulo ou `> agora`). O fim é exclusivo. A conta é feita sobre instantes (fuso nenhum muda o resultado) e as datas
 * sem hora ("2026-10-26") são lidas no dia de America/Sao_Paulo: o início vale à 00:00 do dia e o fim cobre o dia inteiro (exclusivo
 * na 00:00 do dia seguinte), o mesmo fuso dos demais módulos.
 */
const FUSO = 'America/Sao_Paulo';
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 3600 * 1000;

const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** Deslocamento de São Paulo em relação ao UTC, em ms, no instante dado (negativo: atrás do UTC). */
function offsetMs(date) {
  const p = Object.fromEntries(formatter.formatToParts(date).map((x) => [x.type, x.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return wall - Math.floor(date.getTime() / 1000) * 1000;
}

/** Instante da 00:00 (America/Sao_Paulo) do dia civil indicado. */
function startOfDay(year, month, day) {
  const midnightUtc = Date.UTC(year, month - 1, day);
  const first = midnightUtc - offsetMs(new Date(midnightUtc));
  return new Date(midnightUtc - offsetMs(new Date(first)));
}

/** Dia civil (AAAA-MM-DD) de um instante em America/Sao_Paulo. */
function dayOf(date) {
  const p = Object.fromEntries(formatter.formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Limite de vigência recebido da origem: Date/ISO valem como instante; "AAAA-MM-DD" vale como dia de São Paulo (`kind` FROM ou UNTIL). */
function bound(value, kind) {
  if (value === null || value === undefined || value === '') return null;
  const m = typeof value === 'string' ? DATE_ONLY.exec(value.trim()) : null;
  if (m) {
    const start = startOfDay(Number(m[1]), Number(m[2]), Number(m[3]));
    return kind === 'UNTIL' ? startOfDay(...dayAfter(m)) : start;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayAfter(m) {
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + DAY_MS);
  return [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()];
}

const STATUS_AT_RETRIEVAL = Object.freeze({ REVOKED: 'REVOGADA', SUPERSEDED: 'SUBSTITUIDA', EXPIRED: 'EXPIRADA' });

/**
 * Estado da fonte em `now`: VIGENTE, REVOGADA, EXPIRADA, SUBSTITUIDA (versão mais nova da mesma origem) ou NAO_INICIADA (início posterior
 * a `now`). `row` = { status, effectiveFrom, effectiveUntil }.
 */
function statusAt(row, now = new Date()) {
  if (STATUS_AT_RETRIEVAL[row.status]) return STATUS_AT_RETRIEVAL[row.status];
  const at = new Date(now).getTime();
  const from = bound(row.effectiveFrom, 'FROM');
  const until = bound(row.effectiveUntil, 'UNTIL');
  if (from && from.getTime() > at) return 'NAO_INICIADA';
  if (until && until.getTime() <= at) return 'EXPIRADA';
  return 'VIGENTE';
}

const isVigente = (row, now) => statusAt(row, now) === 'VIGENTE';

module.exports = { FUSO, bound, startOfDay, dayOf, statusAt, isVigente };
