'use strict';

/**
 * M9-D686 — parâmetros do administrador da Saúde Geral (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.saude.kpis_por_area   as áreas e os KPIs principais de cada uma: "FINANCE: fin.free_cash, fin.breathing_need, fin.overdue_receivables; LEGAL: ..."
 *   analytics.semaforo.<regra>      a regra de semáforo de um KPI: "AMARELO < 60%; VERMELHO < 40%" (padrão do livro/CSV)
 * Os limiares são apresentação, não fórmula de KPI. Eles viram `dashboard_widgets.config.trafficLight` do painel `health`; mudar um limiar só vale com uma NOVA versão do painel
 * (M9-D687, BI-008): `POST /analytics/dashboards/health/thresholds` lê estes parâmetros e publica a versão da empresa. Arquivo sem dependência de settings.service no topo
 * (evita ciclo); a leitura usa import tardio.
 */
const AppError = require('../../utils/AppError');
const { AREAS, AREA_KEYS, parseAreaKpis, DEFAULT_AREA_KPIS } = require('./dashboards/health/health.areas');
const { parseRule } = require('./dashboards/health/health.rules');
const { getCriticalityRow } = require('./metrics/seed/criticality.table');

const AREAS_KEY = 'analytics.saude.kpis_por_area';

/** O KPI de cada regra e onde ele mede (dimensão do snapshot ou o valor do indicador) e o texto padrão do livro/CSV. */
const RULES = Object.freeze({
  'analytics.semaforo.cor_approval_rate': { metricCode: 'cor.approval_rate_by_provider', dimension: 'taxa_pct', default: 'AMARELO < 60%; VERMELHO < 40%' },
  'analytics.semaforo.crm_without_next_action': { metricCode: 'crm.portfolio_without_next_action', dimension: 'sem_acao_pct', default: 'AMARELO > 15%; VERMELHO > 30%' },
  'analytics.semaforo.fin_breathing_need': { metricCode: 'fin.breathing_need', dimension: null, default: 'AMARELO se > 0' },
  'analytics.semaforo.legal_deadlines_vencidos': { metricCode: 'legal.deadlines', dimension: 'vencidos_qtd', default: 'VERMELHO se > 0' },
  'analytics.semaforo.mkt_deliverability': { metricCode: 'mkt.deliverability', dimension: null, default: 'AMARELO < 95%; VERMELHO < 90%' },
  'analytics.semaforo.obra_progress_deviation': { metricCode: 'obra.progress_vs_schedule', dimension: 'desvio_pp', default: 'AMARELO < -5 p.p.; VERMELHO < -10 p.p.' },
  'analytics.semaforo.rent_vacancy': { metricCode: 'rent.vacancy', dimension: null, default: 'AMARELO > 10%; VERMELHO > 20%' },
  'analytics.semaforo.sup_sla_resolution': { metricCode: 'sup.sla_resolution', dimension: null, default: 'AMARELO < 90%; VERMELHO < 80%' },
  'analytics.semaforo.tec_availability': { metricCode: 'tec.availability', dimension: null, default: 'AMARELO < 99,9%; VERMELHO < 99%' },
});

const domainOf = (code) => (getCriticalityRow(code) || {}).domain || null;

const HEALTH_DEFAULTS = Object.freeze({ [AREAS_KEY]: DEFAULT_AREA_KPIS, ...Object.fromEntries(Object.entries(RULES).map(([key, r]) => [key, r.default])) });

function validateAreas(key, value) {
  if (!parseAreaKpis(value, domainOf)) {
    throw AppError.badRequest(
      `O valor de "${key}" deve ter o formato "ÁREA: código, código; ÁREA: código" com áreas entre ${AREA_KEYS.join(', ')} e indicadores da própria área (até 6 por área).`,
      'SETTING_INVALID_VALUE', { key, value }
    );
  }
}

const validateRule = (key, value) => {
  if (!parseRule(value)) throw AppError.badRequest(`O valor de "${key}" deve ter o formato "AMARELO < 60%; VERMELHO < 40%" (operadores <, <=, >, >=, =, !=).`, 'SETTING_INVALID_VALUE', { key, value });
};

const HEALTH_SETTINGS_SCHEMA = Object.freeze({
  [AREAS_KEY]: { type: 'string', validate: validateAreas },
  ...Object.fromEntries(Object.keys(RULES).map((key) => [key, { type: 'string', validate: validateRule }])),
});

/** { areas: [{ ...área, kpis }], rules: Map(código do KPI -> { dimension, yellow, red }) } vigentes para a empresa; texto ausente ou inválido cai no padrão. */
async function readHealthParams(scope, transaction) {
  const { getSetting } = require('../settings/settings.service');
  const get = (key) => getSetting(key, { companyId: scope.companyId, groupId: scope.groupId }, transaction, HEALTH_DEFAULTS[key]);
  const listed = parseAreaKpis(await get(AREAS_KEY), domainOf) || parseAreaKpis(DEFAULT_AREA_KPIS, domainOf);
  const areas = listed.map((l) => ({ ...AREAS.find((a) => a.key === l.key), kpis: l.kpis }));
  const rules = new Map();
  for (const [key, spec] of Object.entries(RULES)) {
    const rule = parseRule(await get(key)) || parseRule(spec.default);
    rules.set(spec.metricCode, { dimension: spec.dimension, ...rule });
  }
  return { areas, rules };
}

module.exports = { AREAS_KEY, RULES, HEALTH_DEFAULTS, HEALTH_SETTINGS_SCHEMA, readHealthParams };
