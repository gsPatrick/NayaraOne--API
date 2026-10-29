'use strict';

const logger = require('../../utils/logger');
const { getSetting } = require('../../features/settings/settings.service');
const S = require('../../features/core-governance/api-governance/consumers/consumers.settings');
const { evaluateDeprecations } = require('../../features/core-governance/api-governance/consumers/evaluate.service');
const { dateKeyInZone } = require('../../features/core-governance/calendar/sources/time');
const { runForEachCompany } = require('./calendarJobRunner');
const { hourInSaoPaulo } = require('./calendarBackfillJob');

/**
 * apiDeprecationJob (M9-D841 §3.4) — avaliação diária das deprecações de API, na hora configurada (`governanca.api.deprecacao.job_hora`, padrão 07:00 America/Sao_Paulo): vira SUNSET o que
 * passou do desligamento e publica api.consumer.deprecation_due (uma vez por consumidor e deprecação) a `governanca.api.aviso_dias` dias do desligamento. Checa a cada 10 minutos e roda
 * uma vez por dia por empresa; a chave de idempotência do evento garante que reexecutar não duplica. Por empresa, só se o módulo api-governance estiver ligado. Desligar no processo:
 * API_DEPRECATION_JOB_DISABLED=true.
 */
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const lastRunDay = new Map();

const runApiDeprecationJob = (now = new Date(), { force = false } = {}) => runForEachCompany('apiDeprecationJob', async (tenant, transaction) => {
  const hour = Number(await getSetting(S.JOB_HOUR_KEY, tenant, transaction, S.CONSUMERS_SETTING_DEFAULTS[S.JOB_HOUR_KEY]));
  const day = dateKeyInZone(now);
  if (!force && (hourInSaoPaulo(now) !== hour || lastRunDay.get(tenant.companyId) === day)) return null;
  const summary = await evaluateDeprecations({ tenant, now, transaction });
  lastRunDay.set(tenant.companyId, day);
  return summary;
}, 'api-governance');

function startApiDeprecationJob({ intervalMs = CHECK_INTERVAL_MS } = {}) {
  const tick = () => runApiDeprecationJob().catch((err) => logger.error({ err: err.message }, 'apiDeprecationJob.failed'));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runApiDeprecationJob, startApiDeprecationJob };
