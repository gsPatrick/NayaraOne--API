'use strict';

/** Parâmetro da auditoria segura da NAY (M9-D028): tamanho máximo do resumo de entrada e de saída guardado em ai.ai_runs. */
const SUMMARY_MAX_KEY = 'ia.auditoria.resumo_max_caracteres';
// Auditoria e observabilidade (M9-D047) andam juntas: o que a NAY registra e mede do que fez.
const { OBSERVABILITY_SETTING_DEFAULTS, OBSERVABILITY_SETTINGS_SCHEMA } = require('../observability/observability.settings');

const AUDIT_SETTING_DEFAULTS = Object.freeze({ [SUMMARY_MAX_KEY]: 2000, ...OBSERVABILITY_SETTING_DEFAULTS });
const AUDIT_SETTINGS_SCHEMA = { [SUMMARY_MAX_KEY]: { type: 'integer', min: 100, max: 2000 }, ...OBSERVABILITY_SETTINGS_SCHEMA };

module.exports = { SUMMARY_MAX_KEY, AUDIT_SETTING_DEFAULTS, AUDIT_SETTINGS_SCHEMA };
