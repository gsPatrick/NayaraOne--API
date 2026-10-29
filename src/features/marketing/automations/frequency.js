'use strict';

const { evaluateCap } = require('./cadence/frequencyCap');
const { getMarketingParam } = require('./cadence/marketingParam.service');
const { FREQUENCY_CAP_KEY } = require('./cadence/cadence.defaults');
const { listCountedSendTimes } = require('./policy.counting');
const { DAY_MS } = require('./policy.statuses');

/** Cap da versão {max, windowDays, scope} no formato do avaliador ({messages, days}); sem cap da versão, null. */
function versionCapOf(capDaVersao) {
  if (!capDaVersao || !Number.isInteger(capDaVersao.max) || !Number.isInteger(capDaVersao.windowDays)) return null;
  return { messages: capDaVersao.max, days: capDaVersao.windowDays };
}

/**
 * Frequency cap de UMA tentativa de envio (a única avaliação do cap no sistema, chamada de dentro do canSend). O cap efetivo é o
 * MENOR entre o da versão e o global: os dois são avaliados e basta um estourar para bloquear; o nextEligibleAt é o instante em
 * que os dois voltam a liberar. Janela móvel de windowDays x 24 h terminando em `atInstant`.
 */
async function evaluateFrequencyForSend({ personId, channel, purpose, atInstant, capDaVersao }, tenant, transaction) {
  const globalCap = await getMarketingParam(FREQUENCY_CAP_KEY, tenant, transaction);
  const versionCap = versionCapOf(capDaVersao);
  const caps = versionCap ? [globalCap, versionCap] : [globalCap];
  const widest = Math.max(...caps.map((c) => c.days));
  const times = await listCountedSendTimes({ personId, channel, purpose, from: new Date(atInstant.getTime() - widest * DAY_MS), to: atInstant }, tenant, transaction);
  const results = caps.map((cap) => ({ cap, ...evaluateCap(times, atInstant, cap) }));
  const blocking = results.filter((r) => !r.allowed);
  const effective = results.reduce((min, r) => (r.cap.messages < min.cap.messages ? r : min), results[0]);
  if (blocking.length === 0) return { allowed: true, count: effective.count, limit: effective.cap.messages, windowDays: effective.cap.days, nextEligibleAt: null };
  const nextEligibleAt = new Date(Math.max(...blocking.map((r) => r.releasesAt.getTime())));
  const worst = blocking.reduce((a, r) => (r.cap.messages < a.cap.messages ? r : a), blocking[0]);
  return { allowed: false, count: worst.count, limit: worst.cap.messages, windowDays: worst.cap.days, nextEligibleAt };
}

module.exports = { evaluateFrequencyForSend, versionCapOf };
