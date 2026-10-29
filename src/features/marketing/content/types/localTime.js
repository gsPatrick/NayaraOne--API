'use strict';

/**
 * M9-D409 — data e hora de um instante no fuso da empresa (nunca o fuso do servidor). O fuso é o do parâmetro de horário de
 * silêncio do Marketing (M9-D417; padrão America/Sao_Paulo).
 */
async function companyTimeZone(tenant, transaction) {
  const { cadence } = require('../../automations'); // require tardio: evita ciclo de carga entre as áreas
  return (await cadence.getMarketingParam(cadence.QUIET_HOURS_KEY, tenant, transaction)).timeZone;
}

/** { year, month, day, minutes, date: 'YYYY-MM-DD' } de `instant` em `timeZone`. */
function localParts(instant, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant).map((p) => [p.type, p.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return { year, month, day, minutes: Number(parts.hour) * 60 + Number(parts.minute), date: `${parts.year}-${parts.month}-${parts.day}` };
}

const isLeapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** "08:00" -> 480. */
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

module.exports = { companyTimeZone, localParts, isLeapYear, minutesOf };
