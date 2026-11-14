'use strict';

/**
 * Regra AUTO_STRONG parametrizada da conciliação (Guia M4 §9 ">= regra AUTO_STRONG: auto conforme policy; faixa intermediária: sugestão; múltiplos
 * candidatos fortes: AMBIGUOUS, nunca auto"; Caderno §11 "Exato: auto confirmado se fonte confiável. Forte: auto ou revisão conforme regra"; FIN-009
 * "confirmação conforme risco"). O livro dá os pesos do scoreMatch (0,45/0,30/0,15/0,10, fixos em domain/reconciliation.js) e não dá os limiares:
 * eles são parâmetros da empresa (DEC-006, catálogo parametros.csv, aba "Financeiro" de Configurações), com os padrões da decisão.
 *
 *   conciliacao.score_auto_minimo      0,90  (0,50 a 1,00; maior que o mínimo de sugestão; exige MFA)  pontuação a partir da qual é FORTE
 *   conciliacao.score_sugestao_minimo  0,45  (0,10 a 0,99; menor que o mínimo automático; DI-M4CC-3)  pontuação a partir da qual é sugerida
 *   conciliacao.janela_data_dias       3     (0 a 30 dias civis de São Paulo)                           janela do critério de data
 *   conciliacao.folga_ambiguidade      0,05  (0,00 a 1,00; DI-M4CC-3)                                    candidato a menos disso do topo empata -> AMBÍGUO
 *   finance.reconciliation.auto_strong falso (= conciliacao.auto_confirmacao_ativa; exige MFA)          FORTE confirma sozinho?
 *
 * Fonte confiável (DI-M4CC-2, M4-D019 regra "Fonte confiável"): linha de extrato vinda de retorno assinado do provedor (WEBHOOK/PROVIDER_FETCH) ou de
 * arquivo importado por quem tem finance:reconcile. Linha digitada à mão (MANUAL), arquivo importado sem essa permissão e linha anterior à origem
 * registrada (LEGACY) nunca confirmam sozinhas.
 */
const AppError = require('../../../../utils/AppError');
const { registerSettingGuard } = require('../../../../features/settings/settingGuards');

const KEYS = Object.freeze({
  autoScoreMin: 'conciliacao.score_auto_minimo',
  suggestionScoreMin: 'conciliacao.score_sugestao_minimo',
  dateWindowDays: 'conciliacao.janela_data_dias',
  ambiguityGap: 'conciliacao.folga_ambiguidade',
  autoStrong: 'finance.reconciliation.auto_strong',
});

const RECONCILIATION_SETTINGS_SCHEMA = Object.freeze({
  [KEYS.autoScoreMin]: { type: 'number', min: 0.5, max: 1, requiresMfa: true },
  [KEYS.suggestionScoreMin]: { type: 'number', min: 0.1, max: 0.99 },
  [KEYS.dateWindowDays]: { type: 'integer', min: 0, max: 30 },
  [KEYS.ambiguityGap]: { type: 'number', min: 0, max: 1 },
});

const RECONCILIATION_SETTINGS_DEFAULTS = Object.freeze({
  [KEYS.autoScoreMin]: 0.9,
  [KEYS.suggestionScoreMin]: 0.45,
  [KEYS.dateWindowDays]: 3,
  [KEYS.ambiguityGap]: 0.05,
  [KEYS.autoStrong]: false,
});

const SOURCES = Object.freeze({ MANUAL: 'MANUAL', FILE_IMPORT: 'FILE_IMPORT', WEBHOOK: 'WEBHOOK', PROVIDER_FETCH: 'PROVIDER_FETCH', LEGACY: 'LEGACY' });

/** Origem e confiança de uma linha nova de extrato. Só o servidor decide (nunca o corpo do pedido). */
function sourceOf(origin, { canReconcile = false } = {}) {
  if (origin === SOURCES.WEBHOOK || origin === SOURCES.PROVIDER_FETCH) return { source: origin, sourceTrusted: true };
  if (origin === SOURCES.FILE_IMPORT) return { source: origin, sourceTrusted: Boolean(canReconcile) };
  return { source: SOURCES.MANUAL, sourceTrusted: false };
}

function toPolicy(values) {
  return {
    autoScoreMin: Number(values[KEYS.autoScoreMin]),
    suggestionScoreMin: Number(values[KEYS.suggestionScoreMin]),
    dateWindowDays: Number(values[KEYS.dateWindowDays]),
    ambiguityGap: Number(values[KEYS.ambiguityGap]),
    autoStrong: values[KEYS.autoStrong] === true,
  };
}

const DEFAULT_POLICY = Object.freeze(toPolicy(RECONCILIATION_SETTINGS_DEFAULTS));

/** Valor gravado que não é número finito vira o padrão (nunca NaN, que faria a comparação dar "falso"). */
async function readPolicy(tenant, transaction) {
  const { getSetting } = require('../../../../features/settings/settings.service'); // leitura tardia: o dicionário de parâmetros carrega este arquivo
  const values = {};
  for (const [key, fallback] of Object.entries(RECONCILIATION_SETTINGS_DEFAULTS)) {
    // eslint-disable-next-line no-await-in-loop
    const v = await getSetting(key, tenant, transaction, fallback);
    values[key] = typeof fallback === 'boolean' ? v === true : (Number.isFinite(Number(v)) ? Number(v) : fallback);
  }
  return toPolicy(values);
}

/**
 * Decide se a classe final pode ser confirmada sozinha (FIN-009 "conforme risco"). Devolve { allowed, reason } com o motivo em código estável.
 * EXATO: fonte confiável. FORTE: fonte confiável + política AUTO_STRONG ligada + score >= mínimo automático. Demais: nunca.
 * Lançamento retido pelo antifraude (requiresManualReview) nunca é conciliado sozinho.
 */
function autoConfirmDecision({ finalClass, topScore, bankTx, entry }, policy) {
  if (finalClass !== 'EXACT' && finalClass !== 'STRONG') return { allowed: false, reason: 'CLASS_REQUIRES_HUMAN' };
  if (!bankTx || bankTx.sourceTrusted !== true) return { allowed: false, reason: 'UNTRUSTED_SOURCE' };
  if (entry && entry.requiresManualReview) return { allowed: false, reason: 'ENTRY_UNDER_REVIEW' };
  if (finalClass === 'STRONG') {
    if (!policy.autoStrong) return { allowed: false, reason: 'AUTO_STRONG_OFF' };
    if (!(topScore >= policy.autoScoreMin)) return { allowed: false, reason: 'BELOW_AUTO_SCORE' };
  }
  return { allowed: true, reason: null };
}

// Travas: o mínimo automático fica acima do mínimo de sugestão (catálogo: "maior que o mínimo de sugestão" / "menor que o mínimo automático").
const invalid = (key, value, esperado) => AppError.badRequest(`O valor de "${key}" deve ser ${esperado}.`, 'SETTING_INVALID_VALUE', { key, value });
async function current(key, tenant, transaction) {
  return (await readPolicy(tenant, transaction))[Object.keys(KEYS).find((k) => KEYS[k] === key)];
}
registerSettingGuard(KEYS.autoScoreMin, async (value, tenant, _actor, transaction) => {
  const suggestion = await current(KEYS.suggestionScoreMin, tenant, transaction);
  if (!(value > suggestion)) throw invalid(KEYS.autoScoreMin, value, `> ${suggestion} (a pontuação mínima para sugerir)`);
});
registerSettingGuard(KEYS.suggestionScoreMin, async (value, tenant, _actor, transaction) => {
  const auto = await current(KEYS.autoScoreMin, tenant, transaction);
  if (!(value < auto)) throw invalid(KEYS.suggestionScoreMin, value, `< ${auto} (a pontuação mínima para confirmar automaticamente)`);
});

module.exports = { KEYS, SOURCES, RECONCILIATION_SETTINGS_SCHEMA, RECONCILIATION_SETTINGS_DEFAULTS, DEFAULT_POLICY, sourceOf, readPolicy, autoConfirmDecision };
