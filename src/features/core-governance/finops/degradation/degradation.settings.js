'use strict';

/**
 * Parâmetros da degradação por custo (M9-D863; aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv).
 *  - degradacao.ligada: liga a aplicação automática da política (desligada, o job só desfaz o que estiver aplicado).
 *  - degradacao.limiar_primeiro / degradacao.limiar_demais: limiar padrão (% do orçamento) do 1º passo e dos seguintes quando a política não informa (90 e 100).
 *  - degradacao.minuto_job: minuto de cada hora em que o job roda (20).
 *  - degradacao.log_nivel: nível de log do passo REDUCE_LOG_LEVEL (warn).
 *  - degradacao.exportacao_percentual: percentual do max_rows efetivo que sobra no passo LIMIT_EXPORT_SIZE (50 = pela metade).
 *  - degradacao.jobs_baixa_prioridade: nomes dos jobs que o passo DEFER_NON_CRITICAL_JOBS adia, separados por vírgula.
 *  - degradacao.jobs_hora_inicio / degradacao.jobs_hora_fim: janela (Brasília) em que esses jobs seguem rodando durante o passo (00:00 a 05:00).
 */
const D = 'governanca.finops.degradacao.';
const KEYS = Object.freeze({
  enabled: `${D}ligada`, firstThreshold: `${D}limiar_primeiro`, otherThreshold: `${D}limiar_demais`, jobMinute: `${D}minuto_job`, logLevel: `${D}log_nivel`,
  exportPercent: `${D}exportacao_percentual`, lowPriorityJobs: `${D}jobs_baixa_prioridade`, windowStart: `${D}jobs_hora_inicio`, windowEnd: `${D}jobs_hora_fim`,
});

const LOW_PRIORITY_DEFAULT = 'dataQualityScanJob,dataQualityMergeDetectionJob,calendarConflictJob,idempotencyCleanupJob,exportExpiryJob';
const LEVELS = ['warn', 'error', 'fatal'];
const ALERT_THRESHOLDS = [50, 75, 90, 100];

const DEGRADATION_SETTING_DEFAULTS = Object.freeze({
  [KEYS.enabled]: true, [KEYS.firstThreshold]: 90, [KEYS.otherThreshold]: 100, [KEYS.jobMinute]: 20, [KEYS.logLevel]: 'warn',
  [KEYS.exportPercent]: 50, [KEYS.lowPriorityJobs]: LOW_PRIORITY_DEFAULT, [KEYS.windowStart]: 0, [KEYS.windowEnd]: 5,
});

function validateThreshold(key, value) {
  const { govError } = require('../../governance.errors');
  if (!ALERT_THRESHOLDS.includes(Number(value))) throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve ser um dos limiares de alerta: 50, 75, 90 ou 100.`, { key });
}

const DEGRADATION_SETTINGS_SCHEMA = {
  [KEYS.enabled]: { type: 'boolean' },
  [KEYS.firstThreshold]: { type: 'integer', min: 50, max: 100, validate: validateThreshold },
  [KEYS.otherThreshold]: { type: 'integer', min: 50, max: 100, validate: validateThreshold },
  [KEYS.jobMinute]: { type: 'integer', min: 0, max: 59 },
  [KEYS.logLevel]: { type: 'string', enum: LEVELS },
  [KEYS.exportPercent]: { type: 'integer', min: 1, max: 99 },
  [KEYS.lowPriorityJobs]: { type: 'string' },
  [KEYS.windowStart]: { type: 'integer', min: 0, max: 23 },
  [KEYS.windowEnd]: { type: 'integer', min: 1, max: 24 },
};

module.exports = { KEYS, LEVELS, ALERT_THRESHOLDS, DEGRADATION_SETTING_DEFAULTS, DEGRADATION_SETTINGS_SCHEMA };
