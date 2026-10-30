'use strict';

/**
 * Porta única das métricas da NAY (M9-D047): `observe(ctx, transaction, (m) => m.runFinished(run))` só conta quando a empresa mantém ligado o
 * parâmetro ia.observabilidade.metricas_ativas, e qualquer falha (leitura do parâmetro ou contagem) é engolida: observar não quebra o run.
 */
const { getSetting } = require('../../settings/settings.service');
const { metrics } = require('./metrics');
const { METRICS_ENABLED_KEY, OBSERVABILITY_SETTING_DEFAULTS } = require('./observability.settings');

async function metricsEnabled(ctx, transaction) {
  const value = await getSetting(METRICS_ENABLED_KEY, ctx, transaction, OBSERVABILITY_SETTING_DEFAULTS[METRICS_ENABLED_KEY]);
  return value !== false && value !== 'false';
}

async function observe(ctx, transaction, record) {
  try {
    if (!ctx || !ctx.companyId || !(await metricsEnabled(ctx, transaction))) return;
    record(metrics);
  } catch (err) { /* observação nunca derruba a operação */ }
}

module.exports = { observe, metricsEnabled };
