'use strict';

/** Datas do ciclo das obrigações (AAAA-MM-DD, sem fuso): próximo vencimento pela periodicidade e "hoje" no fuso da empresa. */
const MONTHS = { MONTHLY: 1, BIMONTHLY: 2, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12, ONE_TIME: 0 };

/** Vencimento seguinte a `dueOn` (null para ONE_TIME). O dia é o `dueDay` da obrigação ou o do vencimento, limitado ao fim do mês. */
function nextCycleDate(dueOn, periodicity, dueDay) {
  const step = MONTHS[periodicity] === undefined ? 1 : MONTHS[periodicity];
  if (step === 0) return null;
  const [y, m, d] = String(dueOn).slice(0, 10).split('-').map(Number);
  let month = m - 1 + step;
  const year = y + Math.floor(month / 12);
  month %= 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(dueDay || d, lastDay)).padStart(2, '0')}`;
}

function todayIn(zone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone || 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function addDays(ymd, days) {
  const d = new Date(`${String(ymd).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

module.exports = { nextCycleDate, todayIn, addDays, MONTHS };
