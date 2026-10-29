'use strict';

/**
 * Parâmetros do fluxo de execução do run (M9-D020), aba IA NAY. Padrão = Maturacao/demandas/parametros.csv.
 *  - ia.agente.max_voltas: voltas de ferramenta por run (gerar -> executar tool -> devolver ao modelo); a seguinte falha com
 *    422 AI_MAX_TURNS_EXCEEDED;
 *  - ia.agente.timeout_total_ms: tempo total do run; estourar finaliza com 504 AI_RUN_TIMEOUT. O tempo de cada volta é
 *    `ia.agente.timeout_ms` (M9-D004) e o teto de tokens é `ia.agente.max_tokens_run` (M9-D004).
 */
const FLOW_KEYS = Object.freeze({ maxTurns: 'ia.agente.max_voltas', totalTimeoutMs: 'ia.agente.timeout_total_ms' });

const FLOW_SETTING_DEFAULTS = Object.freeze({
  [FLOW_KEYS.maxTurns]: 4,
  [FLOW_KEYS.totalTimeoutMs]: 60000,
});

const FLOW_SETTINGS_SCHEMA = {
  [FLOW_KEYS.maxTurns]: { type: 'integer', min: 1, max: 20 },
  [FLOW_KEYS.totalTimeoutMs]: { type: 'integer', min: 1000, max: 1800000 },
};

module.exports = { FLOW_KEYS, FLOW_SETTING_DEFAULTS, FLOW_SETTINGS_SCHEMA };
