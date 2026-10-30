'use strict';

/**
 * Parâmetros da retenção (aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv). Os prazos abaixo são o valor INICIAL das políticas
 * semeadas (lido quando a política da empresa é criada; depois a política vale, editada por PUT /retention/policies). O livro exige "prazo" sem valores: os padrões são os
 * prazos legais usuais (tributário 5 anos, prescrição geral 10 anos) e a cliente confirma com o jurídico dela.
 */
const PRAZO = (name) => `governanca.retencao.prazo_meses.${name}`;
const KEYS = Object.freeze({
  PRAZO_FISCAL: PRAZO('fiscal'), PRAZO_CONTRATOS: PRAZO('contratos'), PRAZO_JURIDICO: PRAZO('juridico'), PRAZO_LEADS: PRAZO('leads'), PRAZO_LOGS: PRAZO('logs'), PRAZO_AUDITORIA: PRAZO('auditoria'),
  LOTE: 'governanca.retencao.lote_tamanho', AMOSTRA: 'governanca.retencao.amostra_tamanho', VALIDADE_HORAS: 'governanca.retencao.dry_run_validade_horas',
  APPLY_TIMEOUT_MIN: 'governanca.retencao.apply_timeout_min', JOB_HORA: 'governanca.retencao.job_hora', JOB_MINUTO: 'governanca.retencao.job_minuto',
  PAGINA: 'governanca.retencao.pagina_tamanho', INTEGRACAO_AUTOMATICA: 'governanca.retencao.integracao_automatica',
});

const RETENTION_SETTING_DEFAULTS = Object.freeze({
  [KEYS.PRAZO_FISCAL]: 60, [KEYS.PRAZO_CONTRATOS]: 120, [KEYS.PRAZO_JURIDICO]: 120, [KEYS.PRAZO_LEADS]: 24, [KEYS.PRAZO_LOGS]: 18, [KEYS.PRAZO_AUDITORIA]: 60,
  [KEYS.LOTE]: 500, [KEYS.AMOSTRA]: 20, [KEYS.VALIDADE_HORAS]: 72, [KEYS.APPLY_TIMEOUT_MIN]: 30, [KEYS.JOB_HORA]: 3, [KEYS.JOB_MINUTO]: 30, [KEYS.PAGINA]: 50, [KEYS.INTEGRACAO_AUTOMATICA]: true,
});
const months = { type: 'integer', min: 1, max: 1200 };
const RETENTION_SETTINGS_SCHEMA = {
  [KEYS.PRAZO_FISCAL]: months, [KEYS.PRAZO_CONTRATOS]: months, [KEYS.PRAZO_JURIDICO]: months, [KEYS.PRAZO_LEADS]: months, [KEYS.PRAZO_LOGS]: months, [KEYS.PRAZO_AUDITORIA]: months,
  [KEYS.LOTE]: { type: 'integer', min: 1, max: 10000 }, [KEYS.AMOSTRA]: { type: 'integer', min: 1, max: 200 }, [KEYS.VALIDADE_HORAS]: { type: 'integer', min: 1, max: 720 },
  [KEYS.APPLY_TIMEOUT_MIN]: { type: 'integer', min: 1, max: 1440 }, [KEYS.JOB_HORA]: { type: 'integer', min: 0, max: 23 }, [KEYS.JOB_MINUTO]: { type: 'integer', min: 0, max: 59 },
  [KEYS.PAGINA]: { type: 'integer', min: 1, max: 200 }, [KEYS.INTEGRACAO_AUTOMATICA]: { type: 'boolean' },
};

module.exports = { KEYS, RETENTION_SETTING_DEFAULTS, RETENTION_SETTINGS_SCHEMA };
