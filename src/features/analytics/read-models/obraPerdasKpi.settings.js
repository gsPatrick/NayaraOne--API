'use strict';

/**
 * M9-D652 — parâmetros do administrador dos KPIs de desperdício, custo pós-obra e recorrência (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.owner.obra.waste | postwork_cost | recurrence   owner (papel responsável pela reconciliação) de cada KPI
 *   analytics.obra.recorrencia_dias                           janela, em dias de calendário de São Paulo até a data-base, em que as ocorrências da
 *                                                             mesma causa, equipe ou material contam como recorrência (padrão 180)
 *   analytics.obra.recorrencia_min_ocorrencias                quantas ocorrências na janela tornam uma combinação recorrente (padrão 2)
 *   analytics.obra.recorrencia_top                            quantas combinações entram no ranking (padrão 10)
 *   analytics.obra.recorrencia_max_sem_classificacao_pct      % de ocorrências da janela sem causa, sem equipe ou sem material acima do qual o KPI sai
 *                                                             DEGRADED, sem valor (padrão 100: o livro manda contar essas ocorrências em details.unclassified)
 * Arquivo sem dependência de settings.service no topo (evita ciclo); a leitura usa import tardio.
 */
const DEFAULT_OWNER = 'Diretoria de Obras (papel obras-gestor)';
const OBRA_COST_KPI_CODES = Object.freeze(['obra.waste', 'obra.postwork_cost', 'obra.recurrence']);
const OWNER_KEY = (code) => `analytics.owner.${code}`;
const KEYS = Object.freeze({
  windowDays: 'analytics.obra.recorrencia_dias',
  minOccurrences: 'analytics.obra.recorrencia_min_ocorrencias',
  top: 'analytics.obra.recorrencia_top',
  maxUnclassifiedPct: 'analytics.obra.recorrencia_max_sem_classificacao_pct',
});
const RANGES = Object.freeze({ [KEYS.windowDays]: [1, 3650], [KEYS.minOccurrences]: [2, 100], [KEYS.top]: [1, 100], [KEYS.maxUnclassifiedPct]: [0, 100] });

const OBRA_COST_KPI_DEFAULTS = Object.freeze({
  ...Object.fromEntries(OBRA_COST_KPI_CODES.map((code) => [OWNER_KEY(code), DEFAULT_OWNER])),
  [KEYS.windowDays]: 180,
  [KEYS.minOccurrences]: 2,
  [KEYS.top]: 10,
  [KEYS.maxUnclassifiedPct]: 100,
});

const OBRA_COST_KPI_SETTINGS_SCHEMA = Object.freeze({
  ...Object.fromEntries(OBRA_COST_KPI_CODES.map((code) => [OWNER_KEY(code), { type: 'string' }])),
  ...Object.fromEntries(Object.entries(RANGES).map(([key, [min, max]]) => [key, { type: 'integer', min, max }])),
});

const whole = (value, key) => (Number.isInteger(value) && value >= RANGES[key][0] && value <= RANGES[key][1] ? value : OBRA_COST_KPI_DEFAULTS[key]);

/** Parâmetros da recorrência vigentes para a empresa; ausente ou inválido cai no padrão. */
async function readRecurrenceParams(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const get = (key) => getSetting(key, { companyId: scope.companyId, groupId: scope.groupId }, transaction, OBRA_COST_KPI_DEFAULTS[key]);
  const [windowDays, minOccurrences, top, maxUnclassifiedPct] = await Promise.all([get(KEYS.windowDays), get(KEYS.minOccurrences), get(KEYS.top), get(KEYS.maxUnclassifiedPct)]);
  return {
    windowDays: whole(windowDays, KEYS.windowDays), minOccurrences: whole(minOccurrences, KEYS.minOccurrences), top: whole(top, KEYS.top), maxUnclassifiedPct: whole(maxUnclassifiedPct, KEYS.maxUnclassifiedPct),
  };
}

async function readObraCostOwner(metricCode, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = await getSetting(OWNER_KEY(metricCode), { companyId: scope.companyId, groupId: scope.groupId }, transaction, DEFAULT_OWNER);
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_OWNER;
}

module.exports = { OBRA_COST_KPI_CODES, KEYS, OBRA_COST_KPI_DEFAULTS, OBRA_COST_KPI_SETTINGS_SCHEMA, DEFAULT_OWNER, readRecurrenceParams, readObraCostOwner };
