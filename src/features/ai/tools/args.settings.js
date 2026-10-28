'use strict';

/**
 * Parâmetros da validação de argumentos de tool (M9-D018), na aba IA NAY de Configurações. O padrão é o valor inicial de
 * Maturacao/demandas/parametros.csv. São os limites aplicados quando o schema da tool não declara o próprio; o limite escrito
 * no schema da tool vence. Lidos a cada tool call por argsSettings.loadArgsLimits.
 */
const ARGS_SETTING_DEFAULTS = Object.freeze({
  'ia.tool.string_max_caracteres': 500,
  'ia.tool.array_max_itens': 50,
});

const ARGS_SETTINGS_SCHEMA = {
  'ia.tool.string_max_caracteres': { type: 'integer', min: 1, max: 100000 },
  'ia.tool.array_max_itens': { type: 'integer', min: 1, max: 1000 },
};

module.exports = { ARGS_SETTING_DEFAULTS, ARGS_SETTINGS_SCHEMA };
