'use strict';

/**
 * Parâmetros da carga delta da migração v2 (aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv).
 *  - migracao.watermark.sobreposicao_s (P9-EF-062): quantos segundos antes do checkpoint o watermark relê, para não perder linha de commit tardio (padrão 120).
 *  - migracao.lote.tamanho (P9-EF-063): linhas por lote (padrão 2.000).
 *  - migracao.lote.max_tentativas: falhas seguidas do mesmo lote até o executor abortá-lo (padrão 3).
 *  - migracao.lote.timeout_min: minutos até um lote RUNNING sem fim (processo caído) ser dado como FAILED e liberar a fonte (padrão 30).
 *  - migracao.eta.janela_lotes (P9-EF-064): quantos dos últimos lotes concluídos entram na vazão do ETA da Torre de controle (padrão 5).
 */
const KEYS = Object.freeze({
  OVERLAP_S: 'migracao.watermark.sobreposicao_s',
  BATCH_SIZE: 'migracao.lote.tamanho',
  MAX_ATTEMPTS: 'migracao.lote.max_tentativas',
  BATCH_TIMEOUT_MIN: 'migracao.lote.timeout_min',
  ETA_WINDOW: 'migracao.eta.janela_lotes',
});

const INGEST_SETTING_DEFAULTS = Object.freeze({
  [KEYS.OVERLAP_S]: 120, [KEYS.BATCH_SIZE]: 2000, [KEYS.MAX_ATTEMPTS]: 3, [KEYS.BATCH_TIMEOUT_MIN]: 30, [KEYS.ETA_WINDOW]: 5,
});

const INGEST_SETTINGS_SCHEMA = {
  [KEYS.OVERLAP_S]: { type: 'integer', min: 0, max: 86400 },
  [KEYS.BATCH_SIZE]: { type: 'integer', min: 1, max: 100000 },
  [KEYS.MAX_ATTEMPTS]: { type: 'integer', min: 1, max: 20 },
  [KEYS.BATCH_TIMEOUT_MIN]: { type: 'integer', min: 1, max: 1440 },
  [KEYS.ETA_WINDOW]: { type: 'integer', min: 1, max: 100 },
};

module.exports = { KEYS, INGEST_SETTING_DEFAULTS, INGEST_SETTINGS_SCHEMA };
