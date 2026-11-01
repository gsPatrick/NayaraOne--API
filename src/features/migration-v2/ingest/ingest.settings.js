'use strict';

/**
 * Parâmetros da carga delta da migração v2 (aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv).
 *  - migracao.watermark.sobreposicao_s (P9-EF-062): quantos segundos antes do checkpoint o watermark relê, para não perder linha de commit tardio (padrão 120).
 *  - migracao.lote.tamanho (P9-EF-063): linhas por lote (padrão 2.000).
 *  - migracao.lote.max_tentativas: falhas seguidas do mesmo lote até o executor abortá-lo (padrão 3).
 *  - migracao.lote.timeout_min: minutos até um lote RUNNING sem fim (processo caído) ser dado como FAILED e liberar a fonte (padrão 30).
 *  - migracao.eta.janela_lotes (P9-EF-064): quantos dos últimos lotes concluídos entram na vazão do ETA da Torre de controle (padrão 5).
 *  - migracao.execucao.max_por_fonte: execuções ativas (na fila, rodando ou pausadas) que podem existir ao mesmo tempo para a mesma fonte da empresa (padrão 1); a seguinte recebe 409 GOV_MIG_RUN_ALREADY_ACTIVE.
 *  - migracao.execucao.max_por_empresa: teto de execuções ativas da empresa, de qualquer fonte (padrão 3); acima dele, 429 GOV_MIG_RUN_LIMIT.
 *  - migracao.execucao.max_no_processo: teto global de execuções rodando ao mesmo tempo neste processo da API (padrão 5); as demais ficam na fila e o job as retoma.
 *  - migracao.execucao.expira_min: minutos depois dos quais uma execução sem fim (processo caído) deixa de contar como ativa (padrão 720).
 *  - migracao.execucao.expira_replay_min (R3-L6): minutos depois dos quais o registro de controle de um replay de lote sem fim (processo caído) deixa de segurar a vaga e é encerrado como FAILED (padrão 30; o replay é um lote só).
 *  - migracao.legado.filtrar_por_empresa (padrão desligado), migracao.legado.coluna_empresa (padrão empresa_id) e migracao.legado.codigo_empresa (padrão A_DEFINIR, que recusa a carga até ser trocado): ligado, as leituras do sistema antigo só trazem as linhas desta empresa.
 *  - migracao.legado.exigir_filtro_multiempresa: grupo com mais de uma empresa e sem filtro configurado recusa a carga (padrão ligado).
 *  - migracao.payload.retencao_dias: dias, depois de RECONCILED, até o conteúdo de origem (source_payload, com CPF e nascimento) ser descartado do registro (padrão 30; 0 descarta na primeira passagem do job).
 */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
function invalid(key, value, what) {
  const { govError } = require('../../core-governance/governance.errors');
  throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" ${what}`, { key, value });
}

const KEYS = Object.freeze({
  OVERLAP_S: 'migracao.watermark.sobreposicao_s',
  BATCH_SIZE: 'migracao.lote.tamanho',
  MAX_ATTEMPTS: 'migracao.lote.max_tentativas',
  BATCH_TIMEOUT_MIN: 'migracao.lote.timeout_min',
  ETA_WINDOW: 'migracao.eta.janela_lotes',
  EXEC_PER_SOURCE: 'migracao.execucao.max_por_fonte',
  EXEC_PER_COMPANY: 'migracao.execucao.max_por_empresa',
  EXEC_PER_PROCESS: 'migracao.execucao.max_no_processo',
  EXEC_EXPIRE_MIN: 'migracao.execucao.expira_min',
  EXEC_REPLAY_EXPIRE_MIN: 'migracao.execucao.expira_replay_min',
  EXEC_HEARTBEAT_S: 'migracao.execucao.sinal_vida_s',
  LEGACY_FILTER: 'migracao.legado.filtrar_por_empresa',
  LEGACY_COLUMN: 'migracao.legado.coluna_empresa',
  LEGACY_VALUE: 'migracao.legado.codigo_empresa',
  LEGACY_REQUIRE: 'migracao.legado.exigir_filtro_multiempresa',
  PAYLOAD_DAYS: 'migracao.payload.retencao_dias',
});

const INGEST_SETTING_DEFAULTS = Object.freeze({
  [KEYS.OVERLAP_S]: 120, [KEYS.BATCH_SIZE]: 2000, [KEYS.MAX_ATTEMPTS]: 3, [KEYS.BATCH_TIMEOUT_MIN]: 30, [KEYS.ETA_WINDOW]: 5,
  [KEYS.EXEC_PER_SOURCE]: 1, [KEYS.EXEC_PER_COMPANY]: 3, [KEYS.EXEC_PER_PROCESS]: 5, [KEYS.EXEC_EXPIRE_MIN]: 720, [KEYS.EXEC_REPLAY_EXPIRE_MIN]: 30, [KEYS.EXEC_HEARTBEAT_S]: 30,
  [KEYS.LEGACY_FILTER]: false, [KEYS.LEGACY_COLUMN]: 'empresa_id', [KEYS.LEGACY_VALUE]: 'A_DEFINIR', [KEYS.LEGACY_REQUIRE]: true, [KEYS.PAYLOAD_DAYS]: 30,
});

const INGEST_SETTINGS_SCHEMA = {
  [KEYS.OVERLAP_S]: { type: 'integer', min: 0, max: 86400 },
  [KEYS.BATCH_SIZE]: { type: 'integer', min: 1, max: 100000 },
  [KEYS.MAX_ATTEMPTS]: { type: 'integer', min: 1, max: 20 },
  [KEYS.BATCH_TIMEOUT_MIN]: { type: 'integer', min: 1, max: 1440 },
  [KEYS.ETA_WINDOW]: { type: 'integer', min: 1, max: 100 },
  [KEYS.EXEC_PER_SOURCE]: { type: 'integer', min: 1, max: 10 },
  [KEYS.EXEC_PER_COMPANY]: { type: 'integer', min: 1, max: 50 },
  [KEYS.EXEC_PER_PROCESS]: { type: 'integer', min: 1, max: 100 },
  [KEYS.EXEC_EXPIRE_MIN]: { type: 'integer', min: 1, max: 10080 },
  [KEYS.EXEC_REPLAY_EXPIRE_MIN]: { type: 'integer', min: 1, max: 1440 },
  [KEYS.EXEC_HEARTBEAT_S]: { type: 'integer', min: 1, max: 600 },
  [KEYS.LEGACY_FILTER]: { type: 'boolean' },
  [KEYS.LEGACY_COLUMN]: { type: 'string', validate: (key, value) => { if (!IDENT.test(String(value))) invalid(key, value, 'deve ter só letras, números e _ (até 63 caracteres), começando por letra ou _.'); } },
  [KEYS.LEGACY_VALUE]: { type: 'string', validate: (key, value) => { if (String(value).length > 120) invalid(key, value, 'deve ter no máximo 120 caracteres.'); } },
  [KEYS.LEGACY_REQUIRE]: { type: 'boolean' },
  [KEYS.PAYLOAD_DAYS]: { type: 'integer', min: 1, max: 3650 },
};

module.exports = { KEYS, INGEST_SETTING_DEFAULTS, INGEST_SETTINGS_SCHEMA };
