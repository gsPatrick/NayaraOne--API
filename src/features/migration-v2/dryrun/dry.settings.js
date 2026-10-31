'use strict';

/**
 * Parâmetros do ensaio DRY3 e do alerta da janela de comparação (M9-D908; aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv):
 *  - migracao.paralelo.prazo_dias (§3.5): dias de tolerância depois do `ends_at` de uma janela de comparação ainda RUNNING antes do alerta CRÍTICO ao A de PARALLEL_COMPARE_CLOSE (padrão 7).
 *  - migracao.dry3.janela_comparacao_min: duração da janela de comparação paralela que o ensaio abre, em minutos (padrão 10).
 *  - migracao.dry3.exemplos_no_relatorio: quantos registros de exemplo (com a máscara da M9-D915) o relatório do ensaio exibe (padrão 10).
 *  - migracao.dry3.timeout_min: minutos até um ensaio RUNNING sem fim (processo caído) ser dado como ABORTED e liberar um novo (padrão 720).
 *  - migracao.dry3.validade_horas: idade máxima, em horas, do relatório exportado para o GO o aceitar (padrão 168 = 7 dias; o livro não fixa prazo, regra inferida: ensaio velho não prova o corte).
 *  - migracao.dry3.volume_minimo: mínimo de linhas de origem do ensaio para o GO o aceitar (padrão 1000; o livro pede "volume real" sem número: um ensaio com poucas linhas não é volume real).
 *  - migracao.dry3.exigir_commit_igual: o relatório só vale para o commit em execução (padrão ligado; desligar permite o GO com relatório de outro commit).
 *  - migracao.dry3.dados_pessoais_em_claro: o ambiente de ensaio pode ver dado pessoal em claro? Desligado (padrão), os exemplos do relatório saem mascarados. A máscara vale só para a
 *    exibição: hash e comparação usam sempre o valor real dentro do processo.
 */
const KEYS = Object.freeze({
  OVERDUE_DAYS: 'migracao.paralelo.prazo_dias',
  WINDOW_MIN: 'migracao.dry3.janela_comparacao_min',
  SAMPLES: 'migracao.dry3.exemplos_no_relatorio',
  CLEAR_PII: 'migracao.dry3.dados_pessoais_em_claro',
  TIMEOUT_MIN: 'migracao.dry3.timeout_min',
  VALIDITY_HOURS: 'migracao.dry3.validade_horas',
  MIN_VOLUME: 'migracao.dry3.volume_minimo',
  SAME_COMMIT: 'migracao.dry3.exigir_commit_igual',
});

const DRY_SETTING_DEFAULTS = Object.freeze({ [KEYS.OVERDUE_DAYS]: 7, [KEYS.WINDOW_MIN]: 10, [KEYS.SAMPLES]: 10, [KEYS.CLEAR_PII]: false, [KEYS.TIMEOUT_MIN]: 720, [KEYS.VALIDITY_HOURS]: 168, [KEYS.MIN_VOLUME]: 1000, [KEYS.SAME_COMMIT]: true });

const DRY_SETTINGS_SCHEMA = {
  [KEYS.OVERDUE_DAYS]: { type: 'integer', min: 1, max: 365 },
  [KEYS.WINDOW_MIN]: { type: 'integer', min: 1, max: 1440 },
  [KEYS.SAMPLES]: { type: 'integer', min: 0, max: 100 },
  [KEYS.CLEAR_PII]: { type: 'boolean' },
  [KEYS.TIMEOUT_MIN]: { type: 'integer', min: 1, max: 10080 },
  [KEYS.VALIDITY_HOURS]: { type: 'integer', min: 1, max: 8760 },
  [KEYS.MIN_VOLUME]: { type: 'integer', min: 1, max: 1000000000 },
  [KEYS.SAME_COMMIT]: { type: 'boolean' },
};

module.exports = { KEYS, DRY_SETTING_DEFAULTS, DRY_SETTINGS_SCHEMA };
