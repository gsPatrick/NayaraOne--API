'use strict';

const { detectOrphanStorage } = require('./orphanStorage');
const { detectLogVolume } = require('./logVolume');
const { detectQueueBacklog } = require('./queueBacklog');
const { detectAiModelCost } = require('./aiModelCost');
const { detectEgress } = require('./egress');

/**
 * Os cinco detectores do livro (M9-D862). `detector` é o valor gravado em finops_findings.detector; `collector` o nome curto sob o qual a execução (e a falha) fica
 * em governance.cost_collector_runs; `schedule` diz se roda na rodada diária (03:00) ou no intervalo da fila; `detect(tenant, ref, params, tx)` recebe o instante
 * (fila e storage) ou o dia fechado AAAA-MM-DD (logs, IA e egress, `scope: 'day'`).
 */
const DETECTORS = Object.freeze([
  { detector: 'ORPHAN_STORAGE', collector: 'det_orphan_storage', schedule: 'daily', scope: 'now', detect: detectOrphanStorage },
  { detector: 'LOG_VOLUME', collector: 'det_log_volume', schedule: 'daily', scope: 'day', detect: detectLogVolume },
  { detector: 'QUEUE_BACKLOG', collector: 'det_queue_backlog', schedule: 'queue', scope: 'now', detect: detectQueueBacklog },
  { detector: 'AI_MODEL_COST', collector: 'det_ai_model_cost', schedule: 'daily', scope: 'day', detect: detectAiModelCost },
  { detector: 'EGRESS', collector: 'det_egress', schedule: 'daily', scope: 'day', detect: detectEgress },
]);

module.exports = { DETECTORS };
