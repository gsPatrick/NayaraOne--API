'use strict';

/**
 * M9-D630 / M9-D631 — parâmetros do administrador dos KPIs do funil comercial (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.owner.crm.<kpi>                              owner (papel responsável pela reconciliação) de cada um dos seis KPIs
 *   analytics.qualidade.max_origem_vazia_pct               % de leads sem origem acima do qual "Leads por origem" sai DEGRADED (padrão 5)
 *   analytics.qualidade.max_sem_motivo_pct                 % de perdidas sem motivo acima do qual "Motivos de perda" sai DEGRADED (padrão 5)
 *   analytics.qualidade.min_amostra                        mínimo de registros (respondidos, fechadas) para o KPI mostrar valor (padrão 5)
 *   analytics.qualidade.max_oportunidade_sem_corretor_pct  % de oportunidades em aberto sem corretor tolerado em "Carteira sem próxima ação"
 *                                                          (padrão 0: qualquer uma rebaixa, como no livro da demanda)
 *   analytics.comercial.ordem_estagios                     ordem dos estágios do funil nas telas e no detalhe (estágio fora da lista vai depois)
 * Arquivo sem dependência de settings.service no topo (evita ciclo); a leitura usa import tardio.
 */
const AppError = require('../../../utils/AppError');

const DEFAULT_OWNER = 'Gerência Comercial (papel comercial-gestor)';
const CRM_KPI_CODES = Object.freeze([
  'crm.leads_by_origin', 'crm.first_response_time', 'crm.opportunities_by_stage', 'crm.conversion_rate', 'crm.loss_reasons', 'crm.portfolio_without_next_action',
]);
const OWNER_KEY = (code) => `analytics.owner.${code}`;
const KEYS = Object.freeze({
  maxNoOriginPct: 'analytics.qualidade.max_origem_vazia_pct',
  maxNoReasonPct: 'analytics.qualidade.max_sem_motivo_pct',
  minSample: 'analytics.qualidade.min_amostra',
  maxNoBrokerPct: 'analytics.qualidade.max_oportunidade_sem_corretor_pct',
  stageOrder: 'analytics.comercial.ordem_estagios',
});
const DEFAULT_STAGE_ORDER = 'NEW,QUALIFIED,MATCHING,VISIT_SCHEDULED,VISITED,PROPOSAL,FINANCING,CONTRACT,NURTURE,WON,LOST,WITHDRAWN';

const CRM_KPI_DEFAULTS = Object.freeze({
  ...Object.fromEntries(CRM_KPI_CODES.map((code) => [OWNER_KEY(code), DEFAULT_OWNER])),
  [KEYS.maxNoOriginPct]: 5,
  [KEYS.maxNoReasonPct]: 5,
  [KEYS.minSample]: 5,
  [KEYS.maxNoBrokerPct]: 0,
  [KEYS.stageOrder]: DEFAULT_STAGE_ORDER,
});

/** "NEW, QUALIFIED" -> ['NEW', 'QUALIFIED']: de 1 a 40 estágios, cada um com letras, números e _, sem repetição; senão null. */
function parseStageOrder(text) {
  const parts = String(text === undefined || text === null ? '' : text).split(',').map((p) => p.trim().toUpperCase());
  const ok = parts.length >= 1 && parts.length <= 40 && parts.every((p) => /^[A-Z][A-Z0-9_]{0,31}$/.test(p)) && new Set(parts).size === parts.length;
  return ok ? parts : null;
}

function validateStageOrder(key, value) {
  if (!parseStageOrder(value)) throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de estágios separados por vírgula, sem repetir (exemplo: NEW,QUALIFIED,PROPOSAL).`, 'SETTING_INVALID_VALUE', { key, value });
}

const pct = { type: 'integer', min: 0, max: 100 };
const CRM_KPI_SETTINGS_SCHEMA = Object.freeze({
  ...Object.fromEntries(CRM_KPI_CODES.map((code) => [OWNER_KEY(code), { type: 'string' }])),
  [KEYS.maxNoOriginPct]: pct,
  [KEYS.maxNoReasonPct]: pct,
  [KEYS.minSample]: { type: 'integer', min: 1, max: 1000 },
  [KEYS.maxNoBrokerPct]: pct,
  [KEYS.stageOrder]: { type: 'string', validate: validateStageOrder },
});

const whole = (value, key, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : CRM_KPI_DEFAULTS[key]);

/** Parâmetros vigentes para a empresa; ausente ou inválido cai no padrão. */
async function readCrmKpiParams(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const get = (key) => getSetting(key, { companyId: scope.companyId, groupId: scope.groupId }, transaction, CRM_KPI_DEFAULTS[key]);
  const [noOrigin, noReason, sample, noBroker, order] = await Promise.all([get(KEYS.maxNoOriginPct), get(KEYS.maxNoReasonPct), get(KEYS.minSample), get(KEYS.maxNoBrokerPct), get(KEYS.stageOrder)]);
  return {
    maxNoOriginPct: whole(noOrigin, KEYS.maxNoOriginPct, 0, 100),
    maxNoReasonPct: whole(noReason, KEYS.maxNoReasonPct, 0, 100),
    minSample: whole(sample, KEYS.minSample, 1, 1000),
    maxNoBrokerPct: whole(noBroker, KEYS.maxNoBrokerPct, 0, 100),
    stageOrder: parseStageOrder(order) || parseStageOrder(DEFAULT_STAGE_ORDER),
  };
}

async function readCrmOwner(metricCode, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = await getSetting(OWNER_KEY(metricCode), { companyId: scope.companyId, groupId: scope.groupId }, transaction, DEFAULT_OWNER);
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_OWNER;
}

module.exports = {
  CRM_KPI_CODES, KEYS, CRM_KPI_DEFAULTS, CRM_KPI_SETTINGS_SCHEMA, DEFAULT_OWNER, DEFAULT_STAGE_ORDER, parseStageOrder, readCrmKpiParams, readCrmOwner,
};
