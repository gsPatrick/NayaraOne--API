'use strict';

/**
 * Parâmetros dos detectores de desperdício (M9-D862; aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv).
 * O livro lista os cinco detectores e não fixa os limiares: os padrões abaixo são os da demanda.
 *  - orfao_dias: dias sem vínculo e sem dono para um arquivo contar como órfão (30).
 *  - log_x_media: volume de log do dia acima de N vezes a média móvel (3).
 *  - egress_x_media: bytes de saída do dia acima de N vezes a média móvel (3).
 *  - media_dias: dias da média móvel de logs e egress (14).
 *  - fila_max: eventos PENDING acima disso abrem o achado de fila (5000).
 *  - fila_antigos_min / fila_idade_min: ao menos N eventos mais velhos que M minutos abrem o achado de fila (50 eventos, 30 min).
 *  - ia_custo_chamada_centavos: custo médio por chamada de tarefa simples acima disso abre o achado de modelo caro (50 centavos).
 *  - detectores_hora: hora (Brasília) da rodada diária dos detectores (3 = 03:00).
 *  - fila_intervalo_min: intervalo, em minutos, do detector de fila (5).
 */
const D = 'governanca.finops.';
const KEYS = Object.freeze({
  orphanDays: `${D}orfao_dias`, logFactor: `${D}log_x_media`, egressFactor: `${D}egress_x_media`, averageDays: `${D}media_dias`,
  queueMax: `${D}fila_max`, queueOldMin: `${D}fila_antigos_min`, queueAgeMin: `${D}fila_idade_min`, aiCallCents: `${D}ia_custo_chamada_centavos`,
  detectorHour: `${D}detectores_hora`, queueInterval: `${D}fila_intervalo_min`,
});

const DETECTOR_SETTING_DEFAULTS = Object.freeze({
  [KEYS.orphanDays]: 30, [KEYS.logFactor]: 3, [KEYS.egressFactor]: 3, [KEYS.averageDays]: 14, [KEYS.queueMax]: 5000, [KEYS.queueOldMin]: 50,
  [KEYS.queueAgeMin]: 30, [KEYS.aiCallCents]: 50, [KEYS.detectorHour]: 3, [KEYS.queueInterval]: 5,
});

const DETECTOR_SETTINGS_SCHEMA = {
  [KEYS.orphanDays]: { type: 'integer', min: 1, max: 3650 },
  [KEYS.logFactor]: { type: 'integer', min: 2, max: 1000 },
  [KEYS.egressFactor]: { type: 'integer', min: 2, max: 1000 },
  [KEYS.averageDays]: { type: 'integer', min: 2, max: 90 },
  [KEYS.queueMax]: { type: 'integer', min: 1, max: 100000000 },
  [KEYS.queueOldMin]: { type: 'integer', min: 1, max: 100000000 },
  [KEYS.queueAgeMin]: { type: 'integer', min: 1, max: 100000 },
  [KEYS.aiCallCents]: { type: 'integer', min: 0, max: 100000000 },
  [KEYS.detectorHour]: { type: 'integer', min: 0, max: 23 },
  [KEYS.queueInterval]: { type: 'integer', min: 1, max: 1440 },
};

module.exports = { KEYS, DETECTOR_SETTING_DEFAULTS, DETECTOR_SETTINGS_SCHEMA };
