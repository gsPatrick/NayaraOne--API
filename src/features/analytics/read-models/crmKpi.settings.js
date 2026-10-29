'use strict';

/**
 * M9-D630 — parâmetros do administrador dos KPIs de leads por origem e de tempo até a primeira resposta (aba "BI e Centro de Comando" em
 * /painel/configuracoes). A M9-D631 acrescenta os dos outros quatro KPIs do funil:
 *   analytics.owner.crm.<kpi>                              owner (papel responsável pela reconciliação) de cada KPI
 *   analytics.qualidade.max_origem_vazia_pct               % de leads sem origem acima do qual "Leads por origem" sai DEGRADED (padrão 5)
 *   analytics.qualidade.min_amostra                        mínimo de respondidos para o tempo de resposta mostrar valor (padrão 5)
 * Arquivo sem dependência de settings.service no topo (evita ciclo); a leitura usa import tardio.
 */
const DEFAULT_OWNER = 'Gerência Comercial (papel comercial-gestor)';
const CRM_KPI_CODES = Object.freeze(['crm.leads_by_origin', 'crm.first_response_time']);
const OWNER_KEY = (code) => `analytics.owner.${code}`;
const KEYS = Object.freeze({ maxNoOriginPct: 'analytics.qualidade.max_origem_vazia_pct', minSample: 'analytics.qualidade.min_amostra' });

const CRM_KPI_DEFAULTS = Object.freeze({
  ...Object.fromEntries(CRM_KPI_CODES.map((code) => [OWNER_KEY(code), DEFAULT_OWNER])),
  [KEYS.maxNoOriginPct]: 5,
  [KEYS.minSample]: 5,
});

const CRM_KPI_SETTINGS_SCHEMA = Object.freeze({
  ...Object.fromEntries(CRM_KPI_CODES.map((code) => [OWNER_KEY(code), { type: 'string' }])),
  [KEYS.maxNoOriginPct]: { type: 'integer', min: 0, max: 100 },
  [KEYS.minSample]: { type: 'integer', min: 1, max: 1000 },
});

const whole = (value, key, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : CRM_KPI_DEFAULTS[key]);

/** Parâmetros vigentes para a empresa; ausente ou inválido cai no padrão. */
async function readCrmKpiParams(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const get = (key) => getSetting(key, { companyId: scope.companyId, groupId: scope.groupId }, transaction, CRM_KPI_DEFAULTS[key]);
  const [noOrigin, sample] = await Promise.all([get(KEYS.maxNoOriginPct), get(KEYS.minSample)]);
  return { maxNoOriginPct: whole(noOrigin, KEYS.maxNoOriginPct, 0, 100), minSample: whole(sample, KEYS.minSample, 1, 1000) };
}

async function readCrmOwner(metricCode, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = await getSetting(OWNER_KEY(metricCode), { companyId: scope.companyId, groupId: scope.groupId }, transaction, DEFAULT_OWNER);
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_OWNER;
}

module.exports = { CRM_KPI_CODES, KEYS, CRM_KPI_DEFAULTS, CRM_KPI_SETTINGS_SCHEMA, DEFAULT_OWNER, readCrmKpiParams, readCrmOwner };
