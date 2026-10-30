'use strict';

/**
 * Parâmetro da observabilidade da NAY (M9-D047): o administrador liga ou desliga a contagem das métricas ai_* dos eventos da sua empresa.
 * Ligado por padrão (o livro exige observabilidade no Definition of Done). Os limites do histograma de latência valem para o processo
 * inteiro e não para uma empresa; vêm da variável de ambiente AI_LATENCY_BUCKETS_MS (ver docs/runbooks/ai/operacao.md).
 */
const METRICS_ENABLED_KEY = 'ia.observabilidade.metricas_ativas';

const OBSERVABILITY_SETTING_DEFAULTS = Object.freeze({ [METRICS_ENABLED_KEY]: true });
const OBSERVABILITY_SETTINGS_SCHEMA = { [METRICS_ENABLED_KEY]: { type: 'boolean' } };

module.exports = { METRICS_ENABLED_KEY, OBSERVABILITY_SETTING_DEFAULTS, OBSERVABILITY_SETTINGS_SCHEMA };
