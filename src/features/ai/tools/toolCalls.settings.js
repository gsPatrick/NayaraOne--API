'use strict';

/**
 * Parâmetro das chamadas de ferramenta (M9-D006), aba IA NAY de Configurações. O resultado gravado em ai.tool_calls é sempre curto
 * (nunca o documento inteiro): acima do limite guarda só o início, o tamanho e o hash. Padrão = Maturacao/demandas/parametros.csv.
 */
const TOOL_RESULT_MAX_KEY = 'ia.tool_calls.resultado_max_caracteres';

const TOOLCALL_SETTING_DEFAULTS = Object.freeze({ [TOOL_RESULT_MAX_KEY]: 2000 });
const TOOLCALL_SETTINGS_SCHEMA = { [TOOL_RESULT_MAX_KEY]: { type: 'integer', min: 100, max: 20000 } };

module.exports = { TOOL_RESULT_MAX_KEY, TOOLCALL_SETTING_DEFAULTS, TOOLCALL_SETTINGS_SCHEMA };
