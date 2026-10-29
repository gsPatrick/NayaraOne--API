'use strict';

const { lastAcceptedSendAt } = require('./policy.counting');
const { DAY_MS, HOUR_MS } = require('./policy.statuses');

const UNIT_MS = Object.freeze({ HOURS: HOUR_MS, DAYS: DAY_MS });

/**
 * Cooldown {amount, unit: HOURS|DAYS}: descanso mínimo entre duas execuções da MESMA automação para a mesma pessoa no canal.
 * A contagem usa o horário da ação (não o da run). Bloqueia se a última mensagem aceita pelo provedor foi há menos que o cooldown;
 * `nextEligibleAt` = horário dessa mensagem + cooldown (volta a liberar exatamente nesse instante).
 */
async function evaluateCooldown({ flowId, personId, channel, cooldown, now }, tenant, transaction) {
  const unitMs = cooldown && UNIT_MS[cooldown.unit];
  if (!unitMs || !Number.isInteger(cooldown.amount) || cooldown.amount < 1) return { allowed: true, nextEligibleAt: null, lastAt: null };
  const lastAt = await lastAcceptedSendAt({ flowId, personId, channel, to: now }, tenant, transaction);
  if (!lastAt) return { allowed: true, nextEligibleAt: null, lastAt: null };
  const nextEligibleAt = new Date(lastAt.getTime() + cooldown.amount * unitMs);
  return nextEligibleAt.getTime() > now.getTime() ? { allowed: false, nextEligibleAt, lastAt } : { allowed: true, nextEligibleAt: null, lastAt };
}

module.exports = { evaluateCooldown };
