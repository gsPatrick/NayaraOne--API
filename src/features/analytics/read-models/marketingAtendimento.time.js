'use strict';

/**
 * M9-D627 — datas de negócio (America/Sao_Paulo) dos read models de Marketing e Atendimento: chaves de dia e mês, trechos de SQL que
 * convertem um instante para o dia/mês de SP, e as listas de dias e meses que a agenda reconfere.
 */
const { BUSINESS_TIMEZONE, businessDateKey, startOfBusinessDay } = require('../../../utils/businessDate');
const { sequelize } = require('../../../models');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Trechos de SQL: dia ('YYYY-MM-DD') e mês ('YYYY-MM') de SP de uma coluna timestamptz. Use sempre com a replacement :tz. */
const sqlDay = (col) => `to_char((${col} AT TIME ZONE :tz), 'YYYY-MM-DD')`;
const sqlMonth = (col) => `to_char((${col} AT TIME ZONE :tz), 'YYYY-MM')`;
const TZ = { tz: BUSINESS_TIMEZONE };

const dayKey = (value) => (value ? businessDateKey(value) : null);
const monthKey = (value) => (value ? businessDateKey(value).slice(0, 7) : null);

/** Os últimos `count` dias de SP, terminando em `now` (do mais antigo para o de hoje). */
function recentDays(now, count) {
  const today = startOfBusinessDay(now);
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) out.push(businessDateKey(new Date(today.getTime() - i * 86400000 + 12 * 3600000)));
  return out;
}

/** Meses de SP que a janela de dias toca, sem repetir. */
const monthsOf = (days) => [...new Set(days.map((d) => d.slice(0, 7)))];

/** Início (inclusive) e fim (exclusive) do dia de SP 'YYYY-MM-DD', como instantes. */
function dayBounds(day) {
  const start = startOfBusinessDay(new Date(`${day}T12:00:00Z`));
  return { start, end: new Date(start.getTime() + 86400000) };
}

/** Início (inclusive) e fim (exclusive) do mês de SP 'YYYY-MM'. */
function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  return { start: startOfBusinessDay(new Date(Date.UTC(y, m - 1, 1, 12))), end: startOfBusinessDay(new Date(Date.UTC(y, m, 1, 12))) };
}

const rows = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];

module.exports = { DAY_RE, MONTH_RE, UUID_RE, sqlDay, sqlMonth, TZ, dayKey, monthKey, recentDays, monthsOf, dayBounds, monthBounds, rows };
