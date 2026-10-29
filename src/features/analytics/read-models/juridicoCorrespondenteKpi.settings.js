'use strict';

/**
 * M9-D660 — parâmetros do administrador dos KPIs do Jurídico (aba "BI e Centro de Comando" em
 * /painel/configuracoes):
 *   analytics.owner.<código>                                owner (papel responsável pela reconciliação) de cada um dos quatro KPIs
 *   analytics.qualidade.max_sem_risco_pct                   % de processos sem nível de risco acima do qual "Processos por risco" sai DEGRADED (padrão 10)
 *   analytics.qualidade.max_exigencia_sem_prazo_pct         % de exigências pendentes sem prazo acima do qual "Documentos faltantes" sai DEGRADED (padrão 0:
 *                                                           qualquer uma rebaixa, como no livro da demanda)
 * Arquivo sem dependência de settings.service no topo (evita ciclo); a leitura usa import tardio.
 */

const OWNER_LEGAL = 'Jurídico (papel jurídico-gestor)';
const LEGAL_CODES = Object.freeze(['legal.deadlines', 'legal.cases_by_risk', 'legal.values', 'legal.missing_documents']);
const ownerKey = (code) => `analytics.owner.${code}`;
const KEYS = Object.freeze({
  maxNoRiskPct: 'analytics.qualidade.max_sem_risco_pct',
  maxNoDeadlinePct: 'analytics.qualidade.max_exigencia_sem_prazo_pct',
});

const JUR_COR_KPI_DEFAULTS = Object.freeze({
  ...Object.fromEntries(LEGAL_CODES.map((code) => [ownerKey(code), OWNER_LEGAL])),
  [KEYS.maxNoRiskPct]: 10,
  [KEYS.maxNoDeadlinePct]: 0,
});

const pct = { type: 'integer', min: 0, max: 100 };
const JUR_COR_KPI_SETTINGS_SCHEMA = Object.freeze({
  ...Object.fromEntries(LEGAL_CODES.map((code) => [ownerKey(code), { type: 'string' }])),
  [KEYS.maxNoRiskPct]: pct,
  [KEYS.maxNoDeadlinePct]: pct,
});

const whole = (value, key, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : JUR_COR_KPI_DEFAULTS[key]);

/** Parâmetros vigentes para a empresa; ausente ou inválido cai no padrão. */
async function readJurCorKpiParams(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const get = (key) => getSetting(key, { companyId: scope.companyId, groupId: scope.groupId }, transaction, JUR_COR_KPI_DEFAULTS[key]);
  const [noRisk, noDeadline] = await Promise.all([get(KEYS.maxNoRiskPct), get(KEYS.maxNoDeadlinePct)]);
  return {
    maxNoRiskPct: whole(noRisk, KEYS.maxNoRiskPct, 0, 100),
    maxNoDeadlinePct: whole(noDeadline, KEYS.maxNoDeadlinePct, 0, 100),
  };
}

async function readJurCorOwner(metricCode, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const fallback = JUR_COR_KPI_DEFAULTS[ownerKey(metricCode)];
  const value = await getSetting(ownerKey(metricCode), { companyId: scope.companyId, groupId: scope.groupId }, transaction, fallback);
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

module.exports = { LEGAL_CODES, KEYS, JUR_COR_KPI_DEFAULTS, JUR_COR_KPI_SETTINGS_SCHEMA, readJurCorKpiParams, readJurCorOwner };
