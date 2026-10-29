'use strict';

/**
 * M9-D633 — parâmetros do administrador dos KPIs de Radar matches, captação por corretor e conversão por corretor (aba "BI e Centro de Comando" em
 * /painel/configuracoes):
 *   analytics.owner.<código>                       owner (papel responsável pela reconciliação) de cada um dos três indicadores
 *   analytics.qualidade.max_sem_corretor_pct       % de imóveis "Sem captador" acima do qual "Captação por corretor" sai DEGRADED (padrão 5)
 *   analytics.qualidade.min_amostra                mínimo de oportunidades fechadas por corretor para "Conversão por corretor" entrar no ranking (padrão 5)
 * Arquivo sem dependência de settings.service no topo (evita ciclo com settings.service).
 */
const { ownerDefaults, ownerSchema, readSetting, whole } = require('./comercialKpi.settings');

const CORRETORES_KPI_CODES = Object.freeze(['radar.matches', 'crm.broker_capture', 'crm.broker_conversion']);
const KEYS = Object.freeze({ maxNoBrokerPct: 'analytics.qualidade.max_sem_corretor_pct', minSample: 'analytics.qualidade.min_amostra' });

const CORRETORES_KPI_DEFAULTS = Object.freeze({ ...ownerDefaults(CORRETORES_KPI_CODES), [KEYS.maxNoBrokerPct]: 5, [KEYS.minSample]: 5 });

const CORRETORES_KPI_SETTINGS_SCHEMA = Object.freeze({
  ...ownerSchema(CORRETORES_KPI_CODES),
  [KEYS.maxNoBrokerPct]: { type: 'integer', min: 0, max: 100 },
  [KEYS.minSample]: { type: 'integer', min: 1, max: 1000 },
});

/** Limites de qualidade vigentes para a empresa; ausente ou inválido cai no padrão. */
async function readCorretoresKpiParams(scope, transaction) {
  const [noBroker, sample] = await Promise.all([
    readSetting(KEYS.maxNoBrokerPct, scope, transaction, CORRETORES_KPI_DEFAULTS[KEYS.maxNoBrokerPct]),
    readSetting(KEYS.minSample, scope, transaction, CORRETORES_KPI_DEFAULTS[KEYS.minSample]),
  ]);
  return { maxNoBrokerPct: whole(noBroker, CORRETORES_KPI_DEFAULTS[KEYS.maxNoBrokerPct], 0, 100), minSample: whole(sample, CORRETORES_KPI_DEFAULTS[KEYS.minSample], 1, 1000) };
}

module.exports = { CORRETORES_KPI_CODES, KEYS, CORRETORES_KPI_DEFAULTS, CORRETORES_KPI_SETTINGS_SCHEMA, readCorretoresKpiParams };
