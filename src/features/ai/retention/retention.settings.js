'use strict';

/**
 * Parâmetros da retenção do conteúdo da NAY (M9-D028), na aba IA NAY de Configurações. Prazos em dias por classificação do
 * run (a maior entre as fontes). Padrões de Maturacao/demandas/parametros.csv: quanto mais sensível, menor a retenção.
 */
const RETENTION_KEYS = Object.freeze({
  public: 'ia.retencao.public_dias',
  internal: 'ia.retencao.internal_dias',
  confidential: 'ia.retencao.confidential_dias',
  restricted: 'ia.retencao.restricted_dias',
  intervalHours: 'ia.retencao.intervalo_horas',
});

const RETENTION_SETTING_DEFAULTS = Object.freeze({
  [RETENTION_KEYS.public]: 365,
  [RETENTION_KEYS.internal]: 365,
  [RETENTION_KEYS.confidential]: 180,
  [RETENTION_KEYS.restricted]: 30,
  [RETENTION_KEYS.intervalHours]: 24,
});

const days = { type: 'integer', min: 1, max: 3650 };
const RETENTION_SETTINGS_SCHEMA = {
  [RETENTION_KEYS.public]: days,
  [RETENTION_KEYS.internal]: days,
  [RETENTION_KEYS.confidential]: days,
  [RETENTION_KEYS.restricted]: days,
  [RETENTION_KEYS.intervalHours]: { type: 'integer', min: 1, max: 168 },
};

module.exports = { RETENTION_KEYS, RETENTION_SETTING_DEFAULTS, RETENTION_SETTINGS_SCHEMA };
