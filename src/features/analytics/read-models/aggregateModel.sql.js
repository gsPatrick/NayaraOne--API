'use strict';

/**
 * M9-D616 / M9-D617 — trechos de SQL e de data compartilhados pelos read models de várias linhas. Dia sempre pela data de São Paulo
 * (M9-D606); `:today` é a data-base (AAAA-MM-DD) que o recálculo recebe.
 */
const { BUSINESS_TIMEZONE } = require('../../../utils/businessDate');

const ZONE = `'${BUSINESS_TIMEZONE}'`;
/** Data de calendário de São Paulo de uma coluna timestamptz. */
const sqlDay = (col) => `((${col} AT TIME ZONE ${ZONE})::date)`;
/** Mês (AAAA-MM) de calendário de São Paulo de uma coluna timestamptz. */
const sqlMonth = (col) => `to_char(${sqlDay(col)}, 'YYYY-MM')`;
/** Início do dia-base e início do dia seguinte, como instantes. */
const TODAY_START = `(CAST(:today AS date)::timestamp AT TIME ZONE ${ZONE})`;
const DAY_END = `((CAST(:today AS date) + 1)::timestamp AT TIME ZONE ${ZONE})`;

/** 'AAAA-MM-DD' deslocada em `days` dias de calendário (aritmética de calendário, sem relógio). */
function shiftDay(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 'AAAA-MM' deslocado em `months` meses. */
function shiftMonth(monthKey, months) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 7);
}

module.exports = { sqlDay, sqlMonth, TODAY_START, DAY_END, shiftDay, shiftMonth };
