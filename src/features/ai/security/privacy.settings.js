'use strict';

/** Parâmetros de privacidade da NAY (M9-D027), aba IA NAY de Configurações. Padrão = Maturacao/demandas/parametros.csv. */
const PRIVACY_PSEUDONYMIZE_KEY = 'ia.privacidade.pseudonimizar_nomes';

const PRIVACY_SETTING_DEFAULTS = Object.freeze({ [PRIVACY_PSEUDONYMIZE_KEY]: true });
const PRIVACY_SETTINGS_SCHEMA = { [PRIVACY_PSEUDONYMIZE_KEY]: { type: 'boolean' } };

module.exports = { PRIVACY_PSEUDONYMIZE_KEY, PRIVACY_SETTING_DEFAULTS, PRIVACY_SETTINGS_SCHEMA };
