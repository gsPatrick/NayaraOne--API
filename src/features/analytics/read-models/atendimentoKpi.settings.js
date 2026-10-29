'use strict';

/**
 * M9-D672 — parâmetros do administrador dos KPIs de Atendimento do BI (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.owner.<código>                      owner (papel responsável pela reconciliação) de sup.reviews, sup.satisfaction, sup.complaints_by_reason e sup.sla_resolution
 *   analytics.qualidade.max_sem_motivo_pct        % de reclamações sem motivo acima do qual "Reclamações por motivo" sai DEGRADED (padrão 5)
 *   analytics.sla.horas.<prioridade>              horas corridas para resolver um caso de prioridade ALTA, MEDIA ou BAIXA (padrão 24, 72 e 120)
 *   analytics.sla.severidades.<prioridade>        severidades do caso (crm.feedback_cases e chamados) que valem como cada prioridade (padrão HIGH, MEDIUM e LOW)
 * A amostra mínima (analytics.qualidade.min_amostra, padrão 5) é a do funil comercial e do Correspondente: o mesmo parâmetro.
 * Arquivo sem dependência de settings.service no topo (evita ciclo); a leitura usa import tardio.
 */
const { codeList, readCodeList } = require('./settings.codeList');

const OWNER = 'Atendimento (papel atendimento-gestor)';
const CODES = Object.freeze(['sup.reviews', 'sup.satisfaction', 'sup.complaints_by_reason', 'sup.sla_resolution']);
const PRIORITIES = Object.freeze(['ALTA', 'MEDIA', 'BAIXA']);
const ownerKey = (code) => `analytics.owner.${code}`;
const KEYS = Object.freeze({
  minSample: 'analytics.qualidade.min_amostra',
  maxNoReasonPct: 'analytics.qualidade.max_sem_motivo_pct',
  hours: (priority) => `analytics.sla.horas.${priority}`,
  severities: (priority) => `analytics.sla.severidades.${priority}`,
});

const DEFAULT_HOURS = Object.freeze({ ALTA: 24, MEDIA: 72, BAIXA: 120 });
const DEFAULT_SEVERITIES = Object.freeze({ ALTA: 'HIGH', MEDIA: 'MEDIUM', BAIXA: 'LOW' });

const SUPPORT_KPI_DEFAULTS = Object.freeze({
  ...Object.fromEntries(CODES.map((code) => [ownerKey(code), OWNER])),
  [KEYS.maxNoReasonPct]: 5,
  ...Object.fromEntries(PRIORITIES.map((p) => [KEYS.hours(p), DEFAULT_HOURS[p]])),
  ...Object.fromEntries(PRIORITIES.map((p) => [KEYS.severities(p), DEFAULT_SEVERITIES[p]])),
});

const SUPPORT_KPI_SETTINGS_SCHEMA = Object.freeze({
  ...Object.fromEntries(CODES.map((code) => [ownerKey(code), { type: 'string' }])),
  [KEYS.maxNoReasonPct]: { type: 'integer', min: 0, max: 100 },
  ...Object.fromEntries(PRIORITIES.map((p) => [KEYS.hours(p), { type: 'integer', min: 1, max: 8760 }])),
  ...Object.fromEntries(PRIORITIES.map((p) => [KEYS.severities(p), { type: 'string', validate: codeList }])),
});

const whole = (value, fallback, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : fallback);
const getter = (scope, transaction) => {
  const { getSetting } = require('../../settings/settings.service');
  return (key, fallback) => getSetting(key, { companyId: scope.companyId, groupId: scope.groupId }, transaction, fallback);
};

/** Limites de qualidade vigentes da empresa; ausente ou inválido cai no padrão. */
async function readSupportKpiParams(scope, transaction) {
  const get = getter(scope, transaction);
  const [sample, noReason] = await Promise.all([get(KEYS.minSample, 5), get(KEYS.maxNoReasonPct, SUPPORT_KPI_DEFAULTS[KEYS.maxNoReasonPct])]);
  return { minSample: whole(sample, 5, 1, 1000), maxNoReasonPct: whole(noReason, SUPPORT_KPI_DEFAULTS[KEYS.maxNoReasonPct], 0, 100) };
}

/** Política de SLA vigente da empresa: horas e severidades de cada prioridade (a MEDIA vale para o caso sem prioridade). */
async function readSlaPolicy(scope, transaction) {
  const get = getter(scope, transaction);
  const hours = {};
  const severities = {};
  for (const priority of PRIORITIES) {
    hours[priority] = whole(await get(KEYS.hours(priority), DEFAULT_HOURS[priority]), DEFAULT_HOURS[priority], 1, 8760);
    severities[priority] = await readCodeList(KEYS.severities(priority), DEFAULT_SEVERITIES[priority], scope, transaction);
  }
  return { hours, severities };
}

/** Owner vigente do KPI na empresa; ausente cai no padrão. */
async function readSupportOwner(metricCode, scope, transaction) {
  const value = await getter(scope, transaction)(ownerKey(metricCode), OWNER);
  return typeof value === 'string' && value.trim() ? value.trim() : OWNER;
}

module.exports = { CODES, PRIORITIES, KEYS, DEFAULT_HOURS, SUPPORT_KPI_DEFAULTS, SUPPORT_KPI_SETTINGS_SCHEMA, readSupportKpiParams, readSlaPolicy, readSupportOwner };
