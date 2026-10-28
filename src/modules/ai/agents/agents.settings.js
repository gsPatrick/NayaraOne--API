'use strict';

/**
 * Parâmetros dos agentes (M9-D004), na aba IA NAY de Configurações. O padrão é o valor inicial de
 * Maturacao/demandas/parametros.csv. Os quatro limites são o padrão das versões que não definem o próprio (a `limits` da
 * versão vence); as duas chaves booleanas ligam as regras de homologação que o livro deixa em aberto.
 */
const AGENT_SETTING_DEFAULTS = Object.freeze({
  'ia.agente.max_tool_calls_por_run': 5,
  'ia.agente.max_runs_por_minuto_usuario': 10,
  'ia.agente.timeout_ms': 30000,
  'ia.agente.max_tokens_run': 8000,
  'ia.agente.avaliacao_verde_obrigatoria': true,
  'ia.agente.segregacao_funcoes': true,
});

const AGENT_SETTINGS_SCHEMA = {
  'ia.agente.max_tool_calls_por_run': { type: 'integer', min: 1, max: 50 },
  'ia.agente.max_runs_por_minuto_usuario': { type: 'integer', min: 1, max: 600 },
  'ia.agente.timeout_ms': { type: 'integer', min: 1000, max: 300000 },
  'ia.agente.max_tokens_run': { type: 'integer', min: 100, max: 1000000 },
  'ia.agente.avaliacao_verde_obrigatoria': { type: 'boolean' },
  'ia.agente.segregacao_funcoes': { type: 'boolean' },
};

module.exports = { AGENT_SETTING_DEFAULTS, AGENT_SETTINGS_SCHEMA };
