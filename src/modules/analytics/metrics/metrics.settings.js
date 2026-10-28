'use strict';

/**
 * M9-D604 — parâmetros do administrador para o versionamento de métricas (aba "BI e Centro de Comando" em /painel/configuracoes).
 * Dicionário em SETTINGS_SCHEMA (settings.service.js faz o spread). Arquivo sem dependências para não criar ciclo com settings.service.
 */
const REASON_MIN_KEY = 'analytics.metrica.motivo_minimo_caracteres';

// Padrão = o mínimo do livro/demanda (M9-D604, 3.2): o motivo da mudança de fórmula tem ao menos 10 caracteres.
const METRICS_SETTING_DEFAULTS = Object.freeze({ [REASON_MIN_KEY]: 10 });

const METRICS_SETTINGS_SCHEMA = {
  [REASON_MIN_KEY]: { type: 'integer', min: 1, max: 500 },
};

/** Mínimo de caracteres do motivo da nova versão, lido do tenant (cai no padrão se ausente ou inválido). */
async function readReasonMinChars(ctx, transaction) {
  const { getSetting } = require('../../../features/settings/settings.service'); // import tardio: settings.service importa este arquivo
  const value = Number(await getSetting(REASON_MIN_KEY, ctx, transaction, METRICS_SETTING_DEFAULTS[REASON_MIN_KEY]));
  return Number.isInteger(value) && value >= 1 ? value : METRICS_SETTING_DEFAULTS[REASON_MIN_KEY];
}

module.exports = { REASON_MIN_KEY, METRICS_SETTING_DEFAULTS, METRICS_SETTINGS_SCHEMA, readReasonMinChars };
