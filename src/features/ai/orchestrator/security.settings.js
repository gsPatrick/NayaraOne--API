'use strict';

/**
 * Parâmetros de segurança da chamada de tool (M9-D017), na aba IA NAY de Configurações. O padrão é o valor inicial de
 * Maturacao/demandas/parametros.csv: trecho de auditoria de 200 caracteres (livro) e nenhum termo extra de segredo.
 */
const SECURITY_SETTING_DEFAULTS = Object.freeze({
  'ia.seguranca.trecho_auditoria_max_caracteres': 200,
  'ia.seguranca.termos_segredo_extra': '',
});

const SECURITY_SETTINGS_SCHEMA = {
  'ia.seguranca.trecho_auditoria_max_caracteres': { type: 'integer', min: 20, max: 1000 },
  'ia.seguranca.termos_segredo_extra': { type: 'string' },
};

module.exports = { SECURITY_SETTING_DEFAULTS, SECURITY_SETTINGS_SCHEMA };
