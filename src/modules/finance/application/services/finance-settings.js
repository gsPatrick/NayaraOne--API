'use strict';

/**
 * Parâmetros do Financeiro que o administrador grava pela aba "Financeiro" de Configurações (PUT /settings/:key, permissão settings:update, a mesma das
 * demais chaves financeiras). Entram no SETTINGS_SCHEMA do serviço de parâmetros. O livro (Marco 4 §11 e §17) pede os controles e diz "configurável", mas
 * não traz os números: os padrões são os da DEC-007 (Maturacao/demandas/decisoes.csv) e as faixas e rótulos os do catálogo (parametros.csv).
 * FINANCE_SETTINGS_DEFAULTS é a fonte única dos padrões: os leitores do antifraude e a tela usam estes valores.
 *
 * DEC-007 "trocar a regra do Motor pelos parâmetros da tela" (DI-DEC007-2): o valor gravado pela tela vale sempre, mais restritivo ou mais frouxo que o
 * padrão, dentro da faixa do catálogo; nenhuma regra do Motor de Regras condiciona o valor. Falha segura (DI-DEC007-1 corrigida): `readFinanceNumber` é o
 * ÚNICO leitor numérico destes parâmetros e só aceita o valor gravado que é número, finito, inteiro quando a chave é inteira e dentro da faixa; qualquer
 * outra coisa ("", false, [], 0 ou negativo fora da faixa, texto, objeto) vale como o padrão da DEC-007. A gravação fora da faixa é recusada com 422
 * SETTING_INVALID_VALUE e a frase do rótulo (`label` + `invalidStatus`, settingInvalidValue.js).
 * `requiresMfa: true` (parametros.csv coluna exige_mfa_para_alterar): a gravação exige MFA recente de quem altera (settingMfa.js, camada de escrita).
 */
const KEYS = Object.freeze({
  manualReconciliationMinCount: 'finance.antifraud_manual_reconciliation_min_count',
  manualReconciliationWindowDays: 'finance.antifraud_manual_reconciliation_window_days',
  historyMultiplier: 'finance.antifraud_history_multiplier',
  newAccountThreshold: 'finance.antifraud_new_account_threshold',
  bankAccountCooldownHours: 'finance.bank_account_cooldown_hours',
  reconciliationAutoStrong: 'finance.reconciliation.auto_strong',
  // DEC-007 (chaves do catálogo X45-D101).
  outlierBlockMultiplier: 'antifraude.outlier_bloqueio_multiplicador',
  outlierMinSample: 'antifraude.outlier_amostra_minima',
  outlierHistoryMonths: 'antifraude.outlier_historico_meses',
  duplicateWindowDays: 'antifraude.duplicidade_janela_dias',
  newSupplierDays: 'antifraude.fornecedor_novo_dias',
  newSupplierMinAmount: 'antifraude.fornecedor_novo_valor_minimo',
  manualReconciliationUser7d: 'antifraude.conciliacao_manual_usuario_7d',
  manualReconciliationMonthPct: 'antifraude.conciliacao_manual_percentual_mes',
  frequentReversalUser30d: 'antifraude.estorno_frequente_usuario_30d',
  frequentReversalCompany30d: 'antifraude.estorno_frequente_empresa_30d',
});

// Parâmetro numérico do antifraude: rótulo do catálogo na frase de recusa e 422 para valor fora do tipo ou da faixa.
const af = (type, min, max, label, extra = {}) => ({ type, min, max, label, invalidStatus: 422, ...extra });

const FINANCE_SETTINGS_SCHEMA = Object.freeze({
  // §17 "Conciliação manual recorrente -> Alerta gerencial" (manual-reconciliation-alert.js): regra por empresa que já existia (limiar e janela).
  [KEYS.manualReconciliationMinCount]: af('integer', 1, 100, 'Conciliação manual recorrente: conciliações à mão na empresa no período'),
  [KEYS.manualReconciliationWindowDays]: af('integer', 1, 365, 'Conciliação manual recorrente: período considerado (dias)'),
  // DEC-007: o mesmo usuário com N conciliações manuais em 7 dias, ou a empresa com mais de X% das conciliações do mês feitas à mão.
  [KEYS.manualReconciliationUser7d]: af('integer', 1, 100, 'Conciliação manual recorrente: por usuário em 7 dias'),
  [KEYS.manualReconciliationMonthPct]: af('number', 1, 100, 'Conciliação manual recorrente: percentual do mês'),
  // DEC-007 "múltiplo 3,0 revisa": valor / mediana do histórico a partir do qual o pagamento fica retido para revisão (amount-outlier-finding.js).
  [KEYS.historyMultiplier]: af('number', 1, 100, 'Valor fora do padrão: múltiplo da mediana que exige revisão', { rangeNote: 'e não maior que o múltiplo que bloqueia' }),
  // DEC-007 "10,0 bloqueia": a partir deste múltiplo o pagamento também não vira intenção nem pedido de aprovação até a revisão. Trava em finance-setting-guards.js.
  [KEYS.outlierBlockMultiplier]: af('number', 1, 1000, 'Valor fora do padrão: múltiplo que bloqueia', { rangeNote: 'e não menor que o múltiplo de revisão' }),
  // DEC-007 / M4-D022 item 5: mínimo de pagamentos no histórico (abaixo dele usa a categoria inteira da empresa) e meses de histórico considerados.
  [KEYS.outlierMinSample]: af('integer', 1, 100, 'Valor fora do padrão: mínimo de pagamentos no histórico'),
  [KEYS.outlierHistoryMonths]: af('integer', 1, 60, 'Valor fora do padrão: meses de histórico'),
  // DEC-007 "conta nova 48 h e R$ 5.000,00" (FIN-TS-013).
  [KEYS.newAccountThreshold]: af('number', 0, 999999999.99, 'Conta nova: valor a partir do qual exige aprovação extra', { requiresMfa: true }),
  [KEYS.bankAccountCooldownHours]: af('integer', 0, 720, 'Conta bancária nova: horas de espera', { requiresMfa: true }),
  // DEC-007 "duplicidade 90 dias" (payable-antifraud-findings.js).
  [KEYS.duplicateWindowDays]: af('integer', 1, 365, 'Pagamento duplicado: janela de dias'),
  // DEC-007 "fornecedor novo 30 dias e R$ 20.000,00" (§17 "Fornecedor novo de alto valor -> Due diligence/aprovação").
  [KEYS.newSupplierDays]: af('integer', 1, 365, 'Fornecedor novo: dias de cadastro'),
  [KEYS.newSupplierMinAmount]: af('number', 0.01, 999999999.99, 'Fornecedor novo: valor a partir do qual exige verificação'),
  // DEC-007 "estorno frequente 3 por usuário e 5 por empresa em 30 dias" (§17 "Estorno frequente -> Anomaly case"), frequent-reversal-alert.js.
  [KEYS.frequentReversalUser30d]: af('integer', 1, 100, 'Estorno frequente: por usuário em 30 dias'),
  [KEYS.frequentReversalCompany30d]: af('integer', 1, 1000, 'Estorno frequente: por empresa em 30 dias'),
  // §11 "Forte: auto ou revisão conforme regra" (reconciliation.service.js autoReconcileSuggestion): desligado, a correspondência FORTE espera revisão humana.
  // Equivalente a conciliacao.auto_confirmacao_ativa do catálogo (marcada com MFA). Não é antifraude: fica com a recusa 400 de antes.
  [KEYS.reconciliationAutoStrong]: { type: 'boolean', requiresMfa: true },
});

/** Padrão que vale enquanto a empresa não gravou nada, ou gravou valor inválido (DEC-007). */
const FINANCE_SETTINGS_DEFAULTS = Object.freeze({
  [KEYS.manualReconciliationMinCount]: 3,
  [KEYS.manualReconciliationWindowDays]: 30,
  [KEYS.manualReconciliationUser7d]: 5,
  [KEYS.manualReconciliationMonthPct]: 30,
  [KEYS.historyMultiplier]: 3,
  [KEYS.outlierBlockMultiplier]: 10,
  [KEYS.outlierMinSample]: 5,
  [KEYS.outlierHistoryMonths]: 12,
  [KEYS.newAccountThreshold]: 5000,
  [KEYS.bankAccountCooldownHours]: 48,
  [KEYS.duplicateWindowDays]: 90,
  [KEYS.newSupplierDays]: 30,
  [KEYS.newSupplierMinAmount]: 20000,
  [KEYS.frequentReversalUser30d]: 3,
  [KEYS.frequentReversalCompany30d]: 5, // DEC-007, parametros.csv e M4-D006 item 9: 5 por empresa em 30 dias (DI-DEC007-2)
  [KEYS.reconciliationAutoStrong]: false,
});

/** Chaves numéricas lidas por readFinanceNumber (todas as do antifraude). */
const NUMERIC_KEYS = Object.freeze(Object.keys(FINANCE_SETTINGS_SCHEMA).filter((k) => FINANCE_SETTINGS_SCHEMA[k].type !== 'boolean'));

/** O valor gravado vale só se for número finito, inteiro quando a chave é inteira e dentro da faixa do catálogo. */
function isValidStored(key, raw) {
  const spec = FINANCE_SETTINGS_SCHEMA[key];
  if (!spec || typeof raw !== 'number' || !Number.isFinite(raw)) return false;
  if (spec.type === 'integer' && !Number.isInteger(raw)) return false;
  return raw >= spec.min && raw <= spec.max;
}

/**
 * Valor em vigor de um parâmetro numérico do Financeiro e de onde ele vem: STORED (gravado e válido), DEFAULT (nada gravado) ou INVALID_STORED (gravado
 * fora do tipo ou da faixa: vale o padrão da DEC-007). Usado pelo leitor e pela tela (valor efetivo).
 */
async function readFinanceNumberDetail(key, tenant, transaction) {
  if (!NUMERIC_KEYS.includes(key)) throw new Error(`readFinanceNumber: "${key}" não é parâmetro numérico do Financeiro.`);
  const { getSetting } = require('../../../../features/settings/settings.service'); // leitura tardia: o dicionário de parâmetros carrega este arquivo
  const fallback = FINANCE_SETTINGS_DEFAULTS[key];
  const raw = await getSetting(key, tenant, transaction, undefined);
  if (raw === undefined || raw === null) return { key, value: fallback, defaultValue: fallback, stored: null, source: 'DEFAULT' };
  if (isValidStored(key, raw)) return { key, value: raw, defaultValue: fallback, stored: raw, source: 'STORED' };
  return { key, value: fallback, defaultValue: fallback, stored: raw, source: 'INVALID_STORED' };
}

/** Único leitor numérico dos parâmetros do Financeiro (falha segura acima). */
async function readFinanceNumber(key, tenant, transaction) {
  return (await readFinanceNumberDetail(key, tenant, transaction)).value;
}

module.exports = { KEYS, FINANCE_SETTINGS_SCHEMA, FINANCE_SETTINGS_DEFAULTS, NUMERIC_KEYS, isValidStored, readFinanceNumber, readFinanceNumberDetail };

require('./finance-setting-guards'); // depois do exports: a trava lê KEYS e readFinanceNumber deste arquivo
