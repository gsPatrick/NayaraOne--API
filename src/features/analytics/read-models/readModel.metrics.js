'use strict';

/** M9-D607 (3.2 passo 3) — métricas técnicas do worker (Prometheus em /api/metrics): eventos repetidos ignorados e recálculos adiados. */
const client = require('prom-client');
const { register } = require('../../../utils/metrics');

function counter(name, help) {
  return register.getSingleMetric(name) || new client.Counter({ name, help, labelNames: ['read_model'], registers: [register] });
}

const replayIgnored = counter('nayaraone_api_analytics_replay_ignored_total', 'Eventos já aplicados ao read model e ignorados (replay idempotente)');
const staleDeferred = counter('nayaraone_api_analytics_stale_deferred_total', 'Recálculos de agregado adiados para o job agendado por passar do teto de linhas');

module.exports = { replayIgnored, staleDeferred };
