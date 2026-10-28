'use strict';

const { getMarketingParam } = require('./marketingParam.service');
const { QUIET_HOURS_KEY } = require('./cadence.defaults');

function minutesOfDayIn(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return get('hour') * 60 + get('minute');
}

/** O instante cai no horário de silêncio? A janela pode cruzar a meia-noite (início > fim). Início inclusivo, fim exclusivo. */
function isQuietNow(instant, config) {
  const m = minutesOfDayIn(instant, config.timeZone);
  const { startMinutes: s, endMinutes: e } = config;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** Menor instante >= `instant` fora do silêncio (avança de minuto em minuto; no máximo 24 h). */
function nextAllowedInstant(instant, config) {
  let t = new Date(instant.getTime());
  t.setUTCSeconds(0, 0);
  if (!isQuietNow(instant, config)) return new Date(instant.getTime());
  for (let i = 0; i < 24 * 60 + 1; i += 1) {
    t = new Date(t.getTime() + 60000);
    if (!isQuietNow(t, config)) return t;
  }
  return t;
}

/** Lê o horário de silêncio vigente da empresa e avalia o instante. */
async function checkQuietHours(instant, tenant, transaction) {
  const config = await getMarketingParam(QUIET_HOURS_KEY, tenant, transaction);
  const quiet = isQuietNow(instant, config);
  return { quiet, nextAllowedAt: quiet ? nextAllowedInstant(instant, config) : instant, config };
}

module.exports = { isQuietNow, nextAllowedInstant, checkQuietHours };
