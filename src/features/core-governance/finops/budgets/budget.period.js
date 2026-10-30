'use strict';

const { dayKey } = require('../costReadModel');

/** Mês calendário em America/Sao_Paulo (M9-D861 §3.1): 'AAAA-MM' do instante, primeiro e último dia, e se o mês já terminou. */
const monthKeyOf = (date) => dayKey(date).slice(0, 7);

function bounds(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { monthKey, from: `${monthKey}-01`, to: `${monthKey}-${String(last).padStart(2, '0')}` };
}

/** O mês está fechado quando o dia de hoje (Brasília) já passou do último dia dele. */
const isClosed = (monthKey, now) => dayKey(now) > bounds(monthKey).to;

module.exports = { monthKeyOf, bounds, isClosed };
