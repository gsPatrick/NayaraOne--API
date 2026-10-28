'use strict';

/** Parâmetro da auditoria segura da NAY (M9-D028): tamanho máximo do resumo de entrada e de saída guardado em ai.ai_runs. */
const SUMMARY_MAX_KEY = 'ia.auditoria.resumo_max_caracteres';

const AUDIT_SETTING_DEFAULTS = Object.freeze({ [SUMMARY_MAX_KEY]: 2000 });
const AUDIT_SETTINGS_SCHEMA = { [SUMMARY_MAX_KEY]: { type: 'integer', min: 100, max: 2000 } };

module.exports = { SUMMARY_MAX_KEY, AUDIT_SETTING_DEFAULTS, AUDIT_SETTINGS_SCHEMA };
