'use strict';

/**
 * businessDays.helper — extraído de `missingDailyReportJob.js` (GAP 1 da auditoria externa,
 * Marco 6/NAY Obras) para que `nayObras.service.js#summarizeProject` possa detectar "dias úteis
 * sem RDO" usando EXATAMENTE a mesma definição de dia útil do job que já cria tarefa de RDO
 * ausente — nunca duplicar a regra de "o que é dia útil" em dois lugares.
 */

function toDateOnlyString(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * previousBusinessDay — dia útil anterior a `now` (pula sábado/domingo). Mesma lógica usada
 * originalmente só em `missingDailyReportJob.js`.
 */
function previousBusinessDay(now) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - 1);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return date;
}

/**
 * lastBusinessDays — lista (mais recente primeiro) dos últimos `count` dias úteis anteriores a
 * `now`, como strings `YYYY-MM-DD`. Reaproveita `previousBusinessDay` recursivamente para nunca
 * divergir do critério de dia útil do job de detecção de RDO ausente.
 */
function lastBusinessDays(now, count) {
  const days = [];
  let cursor = now;
  for (let i = 0; i < count; i += 1) {
    const day = previousBusinessDay(cursor);
    days.push(toDateOnlyString(day));
    cursor = day;
  }
  return days;
}

module.exports = { toDateOnlyString, previousBusinessDay, lastBusinessDays };
