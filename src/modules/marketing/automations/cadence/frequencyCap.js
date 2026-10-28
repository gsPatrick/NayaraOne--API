'use strict';

const { getMarketingParam } = require('./marketingParam.service');
const { FREQUENCY_CAP_KEY } = require('./cadence.defaults');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `sentAt`: instantes das mensagens já enviadas à mesma pessoa, canal e finalidade. Permite enviar se, na janela dos últimos
 * `days` dias (contados até `now`), houver menos de `messages` envios. Devolve também quando a janela libera a próxima.
 */
function evaluateCap(sentAt, now, cap) {
  const from = now.getTime() - cap.days * DAY_MS;
  const inWindow = sentAt.map((d) => d.getTime()).filter((t) => t > from && t <= now.getTime()).sort((a, b) => a - b);
  const allowed = inWindow.length < cap.messages;
  const releaseIndex = inWindow.length - cap.messages;
  return {
    allowed, count: inWindow.length, limit: cap.messages, windowDays: cap.days,
    releasesAt: allowed ? null : new Date(inWindow[releaseIndex] + cap.days * DAY_MS),
  };
}

/** Lê o cap vigente da empresa e avalia. */
async function checkFrequencyCap(sentAt, now, tenant, transaction) {
  const cap = await getMarketingParam(FREQUENCY_CAP_KEY, tenant, transaction);
  return { ...evaluateCap(sentAt, now, cap), cap };
}

module.exports = { evaluateCap, checkFrequencyCap };
