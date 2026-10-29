'use strict';

/**
 * M9-D670 / M9-D671 — parâmetros do administrador dos KPIs de Marketing no BI (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.owner.<código>                         owner (papel responsável pela reconciliação) de cada um dos oito KPIs
 *   analytics.frequencia.janela_dias                 janela da frequência de contato, em dias (padrão 7; o livro lista a frequência sem janela)
 *   analytics.qualidade.max_sem_campanha_pct         % de leads de marketing sem campanha acima do qual "Leads de marketing" sai DEGRADED (padrão 20)
 *   analytics.qualidade.max_fora_janela_pct          % de atribuições fora da janela do Marketing acima da qual "Atribuição e custo por lead" sai DEGRADED
 *                                                    (padrão 100: no livro a atribuição fora da janela só sai do cálculo e é contada em details.outsideWindow)
 *   analytics.qualidade.mkt_entrega_max_horas        horas sem status de entrega acima das quais "Entregabilidade" sai DEGRADED (padrão 24)
 * Arquivo sem dependência de settings.service no topo (evita ciclo); a leitura usa import tardio.
 */
const OWNER_MKT = 'Marketing (papel marketing-gestor)';
const MKT_CODES = Object.freeze([
  'mkt.campaigns', 'mkt.cost', 'mkt.leads', 'mkt.attribution', 'mkt.deliverability', 'mkt.opt_out', 'mkt.frequency', 'mkt.automations_blocked_failed',
]);
const ownerKey = (code) => `analytics.owner.${code}`;
const KEYS = Object.freeze({
  frequencyWindowDays: 'analytics.frequencia.janela_dias',
  maxNoCampaignPct: 'analytics.qualidade.max_sem_campanha_pct',
  maxOutsideWindowPct: 'analytics.qualidade.max_fora_janela_pct',
  maxDeliveryHours: 'analytics.qualidade.mkt_entrega_max_horas',
});

const MKT_KPI_DEFAULTS = Object.freeze({
  ...Object.fromEntries(MKT_CODES.map((code) => [ownerKey(code), OWNER_MKT])),
  [KEYS.frequencyWindowDays]: 7,
  [KEYS.maxNoCampaignPct]: 20,
  [KEYS.maxOutsideWindowPct]: 100,
  [KEYS.maxDeliveryHours]: 24,
});

const pct = { type: 'integer', min: 0, max: 100 };
const MKT_KPI_SETTINGS_SCHEMA = Object.freeze({
  ...Object.fromEntries(MKT_CODES.map((code) => [ownerKey(code), { type: 'string' }])),
  [KEYS.frequencyWindowDays]: { type: 'integer', min: 1, max: 90 },
  [KEYS.maxNoCampaignPct]: pct,
  [KEYS.maxOutsideWindowPct]: pct,
  [KEYS.maxDeliveryHours]: { type: 'integer', min: 1, max: 720 },
});

const whole = (value, key, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : MKT_KPI_DEFAULTS[key]);

/** Leitura de um parâmetro inteiro da empresa; ausente ou fora da faixa cai no padrão. */
async function readWhole(key, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const { min, max } = MKT_KPI_SETTINGS_SCHEMA[key];
  return whole(await getSetting(key, { companyId: scope.companyId, groupId: scope.groupId }, transaction, MKT_KPI_DEFAULTS[key]), key, min, max);
}

/** Parâmetros vigentes para a empresa. */
async function readMktKpiParams(scope, transaction) {
  const [window, noCampaign, outside, hours] = await Promise.all(Object.values(KEYS).map((key) => readWhole(key, scope, transaction)));
  return { frequencyWindowDays: window, maxNoCampaignPct: noCampaign, maxOutsideWindowPct: outside, maxDeliveryHours: hours };
}

/** Janela da frequência de contato (dias), usada também pelo read model rm_mkt_frequency. */
const readFrequencyWindowDays = (scope, transaction) => readWhole(KEYS.frequencyWindowDays, scope, transaction);

/** Owner vigente do KPI na empresa (texto do parâmetro; vazio cai no padrão). */
async function readMktOwner(metricCode, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = await getSetting(ownerKey(metricCode), { companyId: scope.companyId, groupId: scope.groupId }, transaction, OWNER_MKT);
  return typeof value === 'string' && value.trim() ? value.trim() : OWNER_MKT;
}

module.exports = { MKT_CODES, KEYS, MKT_KPI_DEFAULTS, MKT_KPI_SETTINGS_SCHEMA, readMktKpiParams, readFrequencyWindowDays, readMktOwner };
