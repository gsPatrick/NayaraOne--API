'use strict';

/**
 * M9-D696 — parâmetros do administrador para a qualidade de dados do BI (aba "BI e Centro de Comando" em /painel/configuracoes).
 * Dicionário em SETTINGS_SCHEMA (settings.service.js faz o spread) + leitura única por `readQualityParams`. Padrões: livro e
 * Maturacao/demandas/parametros.csv. Sem dependência de settings.service no topo (evita ciclo; import tardio na leitura).
 *
 *  analytics.qualidade.faixa_contagem_pct        folga da faixa de linhas do refresh (+- % da média dos últimos refreshes)
 *  analytics.qualidade.janela_refreshes          quantos refreshes anteriores entram na média móvel (livro: 14)
 *  analytics.qualidade.min_refreshes_faixa       mínimo de refreshes anteriores para aplicar a faixa (abaixo disso só vale "zero linhas")
 *  analytics.qualidade.max_nulos_pct.<campo>     % de nulos tolerado por campo (padrão 1; 0 para campo usado direto numa fórmula)
 *  analytics.qualidade.max_nulos_bloqueio_pct    acima disso a completude é BLOCK (abaixo, WARN)
 *  analytics.qualidade.tolerancia_conciliacao    diferença aceita entre read model e fonte (R$ 0,01)
 *  analytics.qualidade.severidades               severidade (WARN ou BLOCK) de cada tipo de falha
 *  analytics.qualidade.max_chaves_conciliacao    quantas chaves (as mais recentes) a conciliação de cada read model recalcula da fonte (padrão 200)
 *  analytics.freshness.max_minutos.<DOMINIO>     idade máxima da fonte por domínio (FRESH até aqui; STALE acima)
 *  analytics.freshness.fator_expirado            EXPIRED acima de fator x o limite (livro/M9-D609: 4)
 */
const AppError = require('../../../utils/AppError');

const FRESHNESS_DOMAINS = Object.freeze({ FINANCE: 60, CRM: 60, PROPERTIES: 240, RENTAL: 240, CONSTRUCTION: 240, INVENTORY: 240, LEGAL: 240, CORRESPONDENT: 120, MARKETING: 120, SUPPORT: 60, TECH_AI: 15 });
// Campo -> % de nulos tolerado. 0 para o campo que entra direto numa fórmula (livro, §18); 1 para os demais.
const NULL_FIELDS = Object.freeze({
  due_at: 0, competence_month: 0, result_center_id: 1,
  // M9-D696: campos essenciais da fonte dos read models de domínio (0 = entra direto numa fórmula)
  baseline_amount: 0, commission_amount: 0, cost_actual: 0, total_amount: 0, total_value: 0,
  availability_status: 1, broker_id: 1, cause_code: 1, channel: 1, closed_at: 1, contract_id: 1, created_by: 1, due_date: 1, ends_at: 1, estimated_amount: 1, feedback_type: 1, item_cost: 1, lead_source: 1, next_action: 1, old_price: 1, person_id: 1, planned_end_date: 1, platform: 1, property_id: 1, provider_code: 1, reference_month: 1, requirement_type: 1, risk_level: 1, root_cause_code: 1, satisfaction_score: 1, scheduled_at: 1, sla_due_at: 1, started_at: 1, total_cost: 1,
  // M9-D628: campos essenciais da fonte dos read models de Tecnologia e IA
  probe: 1, event_type: 1, family: 1, last_snapshot_at: 1, reason: 1, kind: 1, cost_amount: 1, grounding_status: 1, status: 1,
});

const SEVERITY_KEYS = Object.freeze(['FRESHNESS_STALE', 'FRESHNESS_EXPIRED', 'DUPLICATION', 'ROW_COUNT_RANGE', 'RECONCILIATION', 'INVARIANT', 'CONSISTENCY', 'COMPLETENESS', 'COMPLETENESS_BLOCK']);
const DEFAULT_SEVERITIES = Object.freeze({
  FRESHNESS_STALE: 'WARN', FRESHNESS_EXPIRED: 'BLOCK', DUPLICATION: 'BLOCK', ROW_COUNT_RANGE: 'BLOCK', RECONCILIATION: 'BLOCK', INVARIANT: 'BLOCK', CONSISTENCY: 'BLOCK',
  COMPLETENESS: 'WARN', COMPLETENESS_BLOCK: 'BLOCK',
});

const K = Object.freeze({
  rangePct: 'analytics.qualidade.faixa_contagem_pct',
  window: 'analytics.qualidade.janela_refreshes',
  minRefreshes: 'analytics.qualidade.min_refreshes_faixa',
  blockNullPct: 'analytics.qualidade.max_nulos_bloqueio_pct',
  tolerance: 'analytics.qualidade.tolerancia_conciliacao',
  severities: 'analytics.qualidade.severidades',
  factor: 'analytics.freshness.fator_expirado',
  maxKeys: 'analytics.qualidade.max_chaves_conciliacao',
});
const nullKey = (field) => `analytics.qualidade.max_nulos_pct.${field}`;
const freshnessKey = (domain) => `analytics.freshness.max_minutos.${domain}`;

const DEFAULT_SEVERITIES_TEXT = SEVERITY_KEYS.map((k) => `${k}=${DEFAULT_SEVERITIES[k]}`).join('; ');
const DEFAULTS = Object.freeze({
  [K.rangePct]: 50, [K.window]: 14, [K.minRefreshes]: 1, [K.blockNullPct]: 5, [K.tolerance]: 'R$ 0,01', [K.severities]: DEFAULT_SEVERITIES_TEXT, [K.factor]: 4, [K.maxKeys]: 200,
  ...Object.fromEntries(Object.entries(NULL_FIELDS).map(([f, v]) => [nullKey(f), v])),
  ...Object.fromEntries(Object.entries(FRESHNESS_DOMAINS).map(([d, v]) => [freshnessKey(d), v])),
});

const TOLERANCE_RE = /^\s*(?:R\$\s*)?(\d{1,12})(?:[.,](\d{1,2}))?\s*$/;

/** "R$ 0,01" | "0,01" | "0.01" | "5" -> "0.01" | "5.00"; texto que não é valor em reais -> null. */
function parseTolerance(text) {
  const m = TOLERANCE_RE.exec(String(text ?? ''));
  return m ? `${m[1]}.${(m[2] || '').padEnd(2, '0')}` : null;
}

/** Texto "CHAVE=WARN; CHAVE=BLOCK" -> mapa completo (o que faltar vale o padrão); null se houver chave desconhecida ou nível inválido. */
function parseSeveritiesStrict(text) {
  const out = { ...DEFAULT_SEVERITIES };
  for (const part of String(text ?? '').split(';').map((p) => p.trim()).filter(Boolean)) {
    const m = /^([A-Z_]+)\s*=\s*(WARN|BLOCK)$/.exec(part);
    if (!m || !SEVERITY_KEYS.includes(m[1])) return null;
    out[m[1]] = m[2];
  }
  return out;
}
const parseSeverities = (text) => parseSeveritiesStrict(text) || { ...DEFAULT_SEVERITIES };

const bad = (key, why) => AppError.badRequest(`O valor de "${key}" ${why}`, 'SETTING_INVALID_VALUE', { key });
const validateTolerance = (key, value) => { if (parseTolerance(value) === null) throw bad(key, 'deve ser um valor em reais, por exemplo R$ 0,01.'); };
const validateSeverities = (key, value) => {
  if (parseSeveritiesStrict(value) === null) throw bad(key, `deve listar CHAVE=WARN ou CHAVE=BLOCK separados por ponto e vírgula, com as chaves: ${SEVERITY_KEYS.join(', ')}.`);
};

const QUALITY_SETTINGS_SCHEMA = {
  [K.rangePct]: { type: 'number', min: 0, max: 1000 },
  [K.window]: { type: 'integer', min: 1, max: 365 },
  [K.minRefreshes]: { type: 'integer', min: 1, max: 365 },
  [K.blockNullPct]: { type: 'number', min: 0, max: 100 },
  [K.tolerance]: { type: 'string', validate: validateTolerance },
  [K.severities]: { type: 'string', validate: validateSeverities },
  [K.factor]: { type: 'integer', min: 1, max: 1000 },
  [K.maxKeys]: { type: 'integer', min: 1, max: 10000 },
  ...Object.fromEntries(Object.keys(NULL_FIELDS).map((f) => [nullKey(f), { type: 'number', min: 0, max: 100 }])),
  ...Object.fromEntries(Object.keys(FRESHNESS_DOMAINS).map((d) => [freshnessKey(d), { type: 'integer', min: 1, max: 525600 }])),
};

const num = (v, fallback, { min = 0, integer = false } = {}) => (typeof v === 'number' && Number.isFinite(v) && v >= min && (!integer || Number.isInteger(v)) ? v : fallback);

/** Parâmetros vigentes da empresa; valor ausente ou inválido cai no padrão. */
async function readQualityParams(scope, transaction) {
  const { listSettingsByPrefix } = require('../../settings/settings.service'); // import tardio: settings.service importa este arquivo
  const rows = [...await listSettingsByPrefix('analytics.qualidade.', scope, transaction), ...await listSettingsByPrefix('analytics.freshness.', scope, transaction)];
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const get = (key) => (stored[key] === undefined ? DEFAULTS[key] : stored[key]);
  return {
    rangePct: num(get(K.rangePct), DEFAULTS[K.rangePct]),
    window: num(get(K.window), DEFAULTS[K.window], { min: 1, integer: true }),
    minRefreshes: num(get(K.minRefreshes), DEFAULTS[K.minRefreshes], { min: 1, integer: true }),
    blockNullPct: num(get(K.blockNullPct), DEFAULTS[K.blockNullPct]),
    tolerance: parseTolerance(get(K.tolerance)) || parseTolerance(DEFAULTS[K.tolerance]),
    severities: parseSeverities(get(K.severities)),
    maxReconcileKeys: num(get(K.maxKeys), DEFAULTS[K.maxKeys], { min: 1, integer: true }),
    freshnessFactor: num(get(K.factor), DEFAULTS[K.factor], { min: 1, integer: true }),
    freshnessLimits: Object.fromEntries(Object.keys(FRESHNESS_DOMAINS).map((d) => [d, num(get(freshnessKey(d)), DEFAULTS[freshnessKey(d)], { min: 1, integer: true })])),
    nullPct: Object.fromEntries(Object.keys(NULL_FIELDS).map((f) => [f, num(get(nullKey(f)), DEFAULTS[nullKey(f)])])),
  };
}

module.exports = { K, DEFAULTS, QUALITY_SETTINGS_SCHEMA, FRESHNESS_DOMAINS, NULL_FIELDS, SEVERITY_KEYS, DEFAULT_SEVERITIES, parseTolerance, parseSeverities, readQualityParams };
