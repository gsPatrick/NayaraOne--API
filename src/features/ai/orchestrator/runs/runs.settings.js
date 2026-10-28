'use strict';

/**
 * Parâmetros do registro de execução (M9-D005), na aba IA NAY de Configurações. O padrão é o valor inicial de
 * Maturacao/demandas/parametros.csv. O limite do trecho de fonte é lido por runSources.excerptLimit a cada gravação.
 */
const RUN_SETTING_DEFAULTS = Object.freeze({
  'ia.fonte.excerpt_max_caracteres': 500,
});

const RUN_SETTINGS_SCHEMA = {
  'ia.fonte.excerpt_max_caracteres': { type: 'integer', min: 50, max: 2000 },
};

module.exports = { RUN_SETTING_DEFAULTS, RUN_SETTINGS_SCHEMA };
