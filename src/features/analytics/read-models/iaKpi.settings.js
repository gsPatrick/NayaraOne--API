'use strict';

/**
 * M9-D681 — parâmetros do administrador dos KPIs de IA do BI (aba "BI e Centro de Comando" em /painel/configuracoes):
 *   analytics.ia.alerta_budget_pct        consumo do orçamento mensal (%) acima do qual o agente é sinalizado em ai.budget (padrão 80)
 *   analytics.ia.qualidade_semanas        quantas semanas (a da data-base e as anteriores) o ai.quality_scores mostra na dimensão "semana" (padrão 4)
 *   analytics.ia.motivos_bloqueio_conhecidos  motivos de bloqueio de ferramenta com linha própria em ai.tool_calls_blocked; os demais somam em "outros" (padrão: os do livro)
 *   analytics.qualidade.min_amostra       menos execuções que isto na semana deixa o ai.quality_scores INCOMPLETE (padrão 5; chave compartilhada com os KPIs do CRM, M9-D630)
 *   analytics.owner.<código>              owner (papel responsável pela reconciliação) de cada KPI de IA
 * Os parâmetros dos read models (M9-D628) ficam em tecnologia.settings.js. Arquivo sem dependência de settings.service no topo (evita ciclo).
 */
const { codeList, readCodeList } = require('./settings.codeList');

const OWNER = 'Tecnologia (papel ti-gestor)';
const CODES = Object.freeze(['ai.cost_by_agent', 'ai.quality_scores', 'ai.budget', 'ai.tool_calls_blocked']);
const ownerKey = (code) => `analytics.owner.${code}`;
const KEYS = Object.freeze({
  alertBudgetPct: 'analytics.ia.alerta_budget_pct',
  qualityWeeks: 'analytics.ia.qualidade_semanas',
  minSample: 'analytics.qualidade.min_amostra',
  knownBlockReasons: 'analytics.ia.motivos_bloqueio_conhecidos',
});

const IA_KPI_DEFAULTS = Object.freeze({
  ...Object.fromEntries(CODES.map((code) => [ownerKey(code), OWNER])),
  [KEYS.alertBudgetPct]: 80, [KEYS.qualityWeeks]: 4, [KEYS.minSample]: 5, [KEYS.knownBlockReasons]: 'ALLOWLIST,PERMISSION,SCHEMA,INJECTION,CROSS_COMPANY,SECRET,BUDGET,POLICY,STALE',
});

// A chave analytics.qualidade.min_amostra já pertence ao esquema do CRM (M9-D630): aqui só é lida.
const IA_KPI_SETTINGS_SCHEMA = Object.freeze({
  ...Object.fromEntries(CODES.map((code) => [ownerKey(code), { type: 'string' }])),
  [KEYS.alertBudgetPct]: { type: 'integer', min: 1, max: 1000 },
  [KEYS.qualityWeeks]: { type: 'integer', min: 1, max: 26 },
  [KEYS.knownBlockReasons]: { type: 'string', validate: codeList },
});

const positiveInt = (v, fallback) => (Number.isInteger(v) && v >= 1 ? v : fallback);

/** Parâmetros dos KPIs de IA vigentes da empresa; ausente ou inválido cai no padrão. */
async function readIaKpiParams(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const ctx = { companyId: scope.companyId, groupId: scope.groupId };
  const int = async (key) => positiveInt(await getSetting(key, ctx, transaction, IA_KPI_DEFAULTS[key]), IA_KPI_DEFAULTS[key]);
  return {
    alertBudgetPct: await int(KEYS.alertBudgetPct), qualityWeeks: await int(KEYS.qualityWeeks), minSample: await int(KEYS.minSample),
    knownBlockReasons: await readCodeList(KEYS.knownBlockReasons, IA_KPI_DEFAULTS[KEYS.knownBlockReasons], scope, transaction),
  };
}

/** Owner vigente do KPI na empresa; ausente cai no padrão. */
async function readIaOwner(metricCode, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const value = await getSetting(ownerKey(metricCode), { companyId: scope.companyId, groupId: scope.groupId }, transaction, OWNER);
  return typeof value === 'string' && value.trim() ? value.trim() : OWNER;
}

module.exports = { CODES, KEYS, OWNER, IA_KPI_DEFAULTS, IA_KPI_SETTINGS_SCHEMA, readIaKpiParams, readIaOwner };
