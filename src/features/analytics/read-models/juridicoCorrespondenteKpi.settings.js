'use strict';

/**
 * M9-D660 / M9-D661 — parâmetros do administrador dos KPIs do Jurídico e do Correspondente Bancário (aba "BI e Centro de Comando" em
 * /painel/configuracoes):
 *   analytics.owner.<código>                                owner (papel responsável pela reconciliação) de cada um dos oito KPIs
 *   analytics.qualidade.max_sem_risco_pct                   % de processos sem nível de risco acima do qual "Processos por risco" sai DEGRADED (padrão 10)
 *   analytics.qualidade.min_amostra                         mínimo de decisões por provider para a taxa de aprovação aparecer (padrão 5)
 *   analytics.qualidade.max_exigencia_sem_prazo_pct         % de exigências pendentes sem prazo acima do qual "Documentos faltantes" sai DEGRADED (padrão 0:
 *                                                           qualquer uma rebaixa, como no livro da demanda)
 *   analytics.correspondente.estagios_validos               estágios que um caso pode ter; caso fora da lista vai para details.invalid
 *   analytics.correspondente.estagios_em_analise            estágios de um caso já enviado e ainda sem decisão (os "pendentes" do tempo de análise)
 * Arquivo sem dependência de settings.service no topo (evita ciclo); a leitura usa import tardio.
 */
const { codeList, CODE_LIST_RE } = require('./settings.codeList');

const OWNER_LEGAL = 'Jurídico (papel jurídico-gestor)';
const OWNER_COR = 'Correspondente Bancário (papel correspondente-gestor)';
const LEGAL_CODES = Object.freeze(['legal.deadlines', 'legal.cases_by_risk', 'legal.values', 'legal.missing_documents']);
const COR_CODES = Object.freeze(['cor.cases_by_stage', 'cor.approval_rate_by_provider', 'cor.analysis_time', 'cor.commission']);
const ownerKey = (code) => `analytics.owner.${code}`;
const KEYS = Object.freeze({
  maxNoRiskPct: 'analytics.qualidade.max_sem_risco_pct',
  minSample: 'analytics.qualidade.min_amostra',
  maxNoDeadlinePct: 'analytics.qualidade.max_exigencia_sem_prazo_pct',
  validStages: 'analytics.correspondente.estagios_validos',
  inAnalysisStages: 'analytics.correspondente.estagios_em_analise',
});

const JUR_COR_KPI_DEFAULTS = Object.freeze({
  ...Object.fromEntries(LEGAL_CODES.map((code) => [ownerKey(code), OWNER_LEGAL])),
  ...Object.fromEntries(COR_CODES.map((code) => [ownerKey(code), OWNER_COR])),
  [KEYS.maxNoRiskPct]: 10,
  [KEYS.minSample]: 5,
  [KEYS.maxNoDeadlinePct]: 0,
  [KEYS.validStages]: 'DRAFT,DOCUMENTS_PENDING,READY_TO_SUBMIT,SUBMITTED,UNDER_ANALYSIS,PENDING_CUSTOMER,PENDING_PROPERTY,APPROVED,REJECTED,CONTRACTING,COMPLETED,CANCELED',
  [KEYS.inAnalysisStages]: 'SUBMITTED,UNDER_ANALYSIS,PENDING_CUSTOMER,PENDING_PROPERTY',
});

const pct = { type: 'integer', min: 0, max: 100 };
const JUR_COR_KPI_SETTINGS_SCHEMA = Object.freeze({
  ...Object.fromEntries([...LEGAL_CODES, ...COR_CODES].map((code) => [ownerKey(code), { type: 'string' }])),
  [KEYS.maxNoRiskPct]: pct,
  [KEYS.minSample]: { type: 'integer', min: 1, max: 1000 },
  [KEYS.maxNoDeadlinePct]: pct,
  [KEYS.validStages]: { type: 'string', validate: codeList },
  [KEYS.inAnalysisStages]: { type: 'string', validate: codeList },
});

const whole = (value, key, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : JUR_COR_KPI_DEFAULTS[key]);
const list = (value, key) => {
  const raw = String(value === undefined || value === null ? '' : value).replace(/\s+/g, '');
  return (CODE_LIST_RE.test(raw) ? raw : JUR_COR_KPI_DEFAULTS[key]).split(',');
};

/** Parâmetros vigentes para a empresa; ausente ou inválido cai no padrão. */
async function readJurCorKpiParams(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const get = (key) => getSetting(key, { companyId: scope.companyId, groupId: scope.groupId }, transaction, JUR_COR_KPI_DEFAULTS[key]);
  const [noRisk, sample, noDeadline, valid, inAnalysis] = await Promise.all([get(KEYS.maxNoRiskPct), get(KEYS.minSample), get(KEYS.maxNoDeadlinePct), get(KEYS.validStages), get(KEYS.inAnalysisStages)]);
  return {
    maxNoRiskPct: whole(noRisk, KEYS.maxNoRiskPct, 0, 100),
    minSample: whole(sample, KEYS.minSample, 1, 1000),
    maxNoDeadlinePct: whole(noDeadline, KEYS.maxNoDeadlinePct, 0, 100),
    validStages: list(valid, KEYS.validStages),
    inAnalysisStages: list(inAnalysis, KEYS.inAnalysisStages),
  };
}

async function readJurCorOwner(metricCode, scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const fallback = JUR_COR_KPI_DEFAULTS[ownerKey(metricCode)];
  const value = await getSetting(ownerKey(metricCode), { companyId: scope.companyId, groupId: scope.groupId }, transaction, fallback);
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

module.exports = { LEGAL_CODES, COR_CODES, KEYS, JUR_COR_KPI_DEFAULTS, JUR_COR_KPI_SETTINGS_SCHEMA, readJurCorKpiParams, readJurCorOwner };
