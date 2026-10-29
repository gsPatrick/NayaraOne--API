'use strict';

/**
 * Parâmetros da memória da NAY (M9-D009), na aba IA NAY de Configurações. Padrão = valor inicial de Maturacao/demandas/parametros.csv.
 * `ia.memoria.guardar_conversa_inteira` é declarado em settings.service.js (M9-D002) e lido por guards/naoImprovisar.
 */
const MEMORY_KEYS = Object.freeze({
  valueMax: 'ia.memoria.valor_max_caracteres',
  validityDays: 'ia.memoria.validade_dias',
  maxContextItems: 'ia.memoria.max_itens_contexto',
  transcriptHours: 'ia.memoria.transcript_validade_horas',
  transcriptMax: 'ia.memoria.transcript_max_caracteres',
  sessionDays: 'ia.memoria.validade_sessao_dias',
  piiTypes: 'ia.memoria.tipos_com_dado_pessoal',
  expiryIntervalHours: 'ia.memoria.intervalo_expiracao_horas',
});

const MEMORY_SETTING_DEFAULTS = Object.freeze({
  [MEMORY_KEYS.valueMax]: 300,
  [MEMORY_KEYS.validityDays]: 180,
  [MEMORY_KEYS.maxContextItems]: 10,
  [MEMORY_KEYS.transcriptHours]: 24,
  [MEMORY_KEYS.transcriptMax]: 4000,
  [MEMORY_KEYS.sessionDays]: 1,
  [MEMORY_KEYS.piiTypes]: 'COMPANY_PREFERENCE',
  [MEMORY_KEYS.expiryIntervalHours]: 24,
});

const MEMORY_SETTINGS_SCHEMA = {
  [MEMORY_KEYS.valueMax]: { type: 'integer', min: 20, max: 2000 },
  [MEMORY_KEYS.validityDays]: { type: 'integer', min: 1, max: 3650 },
  [MEMORY_KEYS.maxContextItems]: { type: 'integer', min: 1, max: 50 },
  [MEMORY_KEYS.transcriptHours]: { type: 'integer', min: 1, max: 168 },
  [MEMORY_KEYS.transcriptMax]: { type: 'integer', min: 100, max: 20000 },
  [MEMORY_KEYS.sessionDays]: { type: 'integer', min: 1, max: 30 },
  [MEMORY_KEYS.piiTypes]: { type: 'string' },
  [MEMORY_KEYS.expiryIntervalHours]: { type: 'integer', min: 1, max: 168 },
};

module.exports = { MEMORY_KEYS, MEMORY_SETTING_DEFAULTS, MEMORY_SETTINGS_SCHEMA };
