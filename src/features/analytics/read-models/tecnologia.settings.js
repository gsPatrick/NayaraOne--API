'use strict';

/**
 * M9-D628 — parâmetros do administrador dos read models de Tecnologia e IA do BI (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.tec.historico_dias       dias de São Paulo de histórico dos read models de Tecnologia e IA (sondas, bloqueios, falhas de autenticação, custo e qualidade; padrão 35: cobre o mês inteiro)
 *   analytics.tec.sondas               sondas ligadas (API, DATABASE, QUEUE, STORAGE)
 *   analytics.tec.intervalo_sonda_s    intervalo das sondas em segundos (padrão 60: a cada minuto); também define as sondas ESPERADAS por dia
 *   analytics.tec.sinais_retencao_dias dias que o registro de sinais técnicos (sondas e falhas de autenticação) é mantido (padrão 40, acima do histórico)
 * Os parâmetros dos KPIs de Tecnologia (M9-D680) ficam em tecnologiaKpi.settings.js. Arquivo sem dependência de settings.service no topo (evita ciclo).
 */
const { codeList, readCodeList } = require('./settings.codeList');

const KEYS = Object.freeze({
  historyDays: 'analytics.tec.historico_dias',
  probes: 'analytics.tec.sondas',
  probeIntervalS: 'analytics.tec.intervalo_sonda_s',
  signalRetentionDays: 'analytics.tec.sinais_retencao_dias',
});

const TECH_DEFAULTS = Object.freeze({ [KEYS.historyDays]: 35, [KEYS.probes]: 'API,DATABASE,QUEUE,STORAGE', [KEYS.probeIntervalS]: 60, [KEYS.signalRetentionDays]: 40 });

const TECH_SETTINGS_SCHEMA = Object.freeze({
  [KEYS.historyDays]: { type: 'integer', min: 1, max: 366 },
  [KEYS.probes]: { type: 'string', validate: codeList },
  [KEYS.probeIntervalS]: { type: 'integer', min: 5, max: 3600 },
  [KEYS.signalRetentionDays]: { type: 'integer', min: 1, max: 3650 },
});

const positiveInt = (v, fallback) => (Number.isInteger(v) && v >= 1 ? v : fallback);

/** Parâmetros vigentes da empresa (`scope.companyId`); ausente ou inválido cai no padrão. */
async function readTechParams(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service'); // import tardio: settings.service importa este arquivo
  const ctx = { companyId: scope.companyId, groupId: scope.groupId };
  const int = async (key) => positiveInt(await getSetting(key, ctx, transaction, TECH_DEFAULTS[key]), TECH_DEFAULTS[key]);
  return {
    historyDays: await int(KEYS.historyDays),
    probeIntervalS: await int(KEYS.probeIntervalS),
    signalRetentionDays: await int(KEYS.signalRetentionDays),
    probes: await readCodeList(KEYS.probes, TECH_DEFAULTS[KEYS.probes], scope, transaction),
  };
}

module.exports = { KEYS, TECH_DEFAULTS, TECH_SETTINGS_SCHEMA, readTechParams };
