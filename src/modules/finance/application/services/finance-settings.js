'use strict';

/**
 * Parâmetros do Financeiro que o administrador grava pela aba "Financeiro" de Configurações (PUT /settings/:key, permissão settings:update, a mesma das
 * demais chaves financeiras). Entram no SETTINGS_SCHEMA do serviço de parâmetros, que recusa com 400 SETTING_INVALID_VALUE qualquer valor fora do tipo ou da
 * faixa. O livro (Marco 4 §11 e §17) pede os controles e diz "configurável", mas não traz os números: os padrões são os da DEC-007 (Maturacao/demandas/
 * decisoes.csv) e as faixas as do catálogo de parâmetros (parametros.csv). FINANCE_SETTINGS_DEFAULTS é a fonte única dos padrões: os leitores do antifraude
 * (finance-antifraud.service.js, payable-antifraud-findings.js, manual-reconciliation-alert.js, frequent-reversal-alert.js) e a tela usam estes valores.
 *
 * DEC-007 com falha segura (DI-DEC007-1): onde o padrão da decisão afrouxaria uma regra que já existia, vale o resultado mais restritivo — a conciliação manual
 * recorrente por empresa (3 em 30 dias) e o estorno frequente por empresa (3 em 30 dias) continuam disparando além das regras novas da decisão.
 * `requiresMfa: true` (DEC-007/parametros.csv coluna exige_mfa_para_alterar): a gravação exige MFA recente de quem altera (settingMfa.js, camada de escrita).
 */
const KEYS = Object.freeze({
  manualReconciliationMinCount: 'finance.antifraud_manual_reconciliation_min_count',
  manualReconciliationWindowDays: 'finance.antifraud_manual_reconciliation_window_days',
  historyMultiplier: 'finance.antifraud_history_multiplier',
  newAccountThreshold: 'finance.antifraud_new_account_threshold',
  bankAccountCooldownHours: 'finance.bank_account_cooldown_hours',
  reconciliationAutoStrong: 'finance.reconciliation.auto_strong',
  // DEC-007 (chaves do catálogo X45-D101 que o código ainda não tinha).
  outlierBlockMultiplier: 'antifraude.outlier_bloqueio_multiplicador',
  duplicateWindowDays: 'antifraude.duplicidade_janela_dias',
  newSupplierDays: 'antifraude.fornecedor_novo_dias',
  newSupplierMinAmount: 'antifraude.fornecedor_novo_valor_minimo',
  manualReconciliationUser7d: 'antifraude.conciliacao_manual_usuario_7d',
  manualReconciliationMonthPct: 'antifraude.conciliacao_manual_percentual_mes',
  frequentReversalUser30d: 'antifraude.estorno_frequente_usuario_30d',
  frequentReversalCompany30d: 'antifraude.estorno_frequente_empresa_30d',
});

const FINANCE_SETTINGS_SCHEMA = Object.freeze({
  // §17 "Conciliação manual recorrente -> Alerta gerencial" (manual-reconciliation-alert.js): quantas conciliações feitas à mão na empresa, dentro da janela, abrem o caso.
  [KEYS.manualReconciliationMinCount]: { type: 'integer', min: 1, max: 100 },
  [KEYS.manualReconciliationWindowDays]: { type: 'integer', min: 1, max: 365 },
  // DEC-007: o mesmo usuário com N conciliações manuais em 7 dias, ou a empresa com X% das conciliações do mês feitas à mão (o que vier primeiro).
  [KEYS.manualReconciliationUser7d]: { type: 'integer', min: 1, max: 100 },
  [KEYS.manualReconciliationMonthPct]: { type: 'number', min: 1, max: 100 },
  // FIN-005 (finance-antifraud.service.js): o QUANTO é ajustável aqui; o SE a regra está ativa é do Motor de Regras (evaluateRule('FIN-005'), fail-closed).
  [KEYS.historyMultiplier]: { type: 'number', min: 1, max: 100 },
  // DEC-007 "múltiplo 3,0 revisa e 10,0 bloqueia": a partir deste múltiplo o pagamento retido também não avança (intenção/aprovação recusadas até a revisão).
  // Não menor que o múltiplo de revisão (trava em finance-setting-guards.js).
  [KEYS.outlierBlockMultiplier]: { type: 'number', min: 1, max: 1000 },
  // DEC-007 "conta nova 48 h e R$ 5.000,00" (FIN-TS-013): o valor do primeiro pagamento a uma conta sem histórico que fica retido para revisão.
  [KEYS.newAccountThreshold]: { type: 'number', min: 0, max: 999999999.99, requiresMfa: true },
  // FIN-TS-013 "Conta nova | Pagamento alto imediato | Controle extra": resfriamento, em horas, da conta bancária nova ou alterada (mesma regra FIN-005).
  [KEYS.bankAccountCooldownHours]: { type: 'integer', min: 0, max: 720, requiresMfa: true },
  // DEC-007 "duplicidade 90 dias": mesmo favorecido (conta), valor e vencimento de outro pagamento não cancelado criado nesta janela => retido e bloqueado.
  [KEYS.duplicateWindowDays]: { type: 'integer', min: 1, max: 365 },
  // DEC-007 "fornecedor novo 30 dias e R$ 20.000,00" (§17 "Fornecedor novo de alto valor -> Due diligence/aprovação").
  [KEYS.newSupplierDays]: { type: 'integer', min: 1, max: 365 },
  [KEYS.newSupplierMinAmount]: { type: 'number', min: 0.01, max: 999999999.99 },
  // DEC-007 "estorno frequente 3 por usuário e 5 por empresa em 30 dias" (§17 "Estorno frequente -> Anomaly case"), frequent-reversal-alert.js.
  [KEYS.frequentReversalUser30d]: { type: 'integer', min: 1, max: 100 },
  [KEYS.frequentReversalCompany30d]: { type: 'integer', min: 1, max: 1000 },
  // §11 "Forte: auto ou revisão conforme regra" (reconciliation.service.js autoReconcileSuggestion): desligado, a correspondência FORTE espera revisão humana.
  // Equivalente a conciliacao.auto_confirmacao_ativa do catálogo (marcada com MFA).
  [KEYS.reconciliationAutoStrong]: { type: 'boolean', requiresMfa: true },
});

/** Padrão que vale enquanto a empresa não gravou nada (o mesmo que cada leitor usa como fallback). */
const FINANCE_SETTINGS_DEFAULTS = Object.freeze({
  [KEYS.manualReconciliationMinCount]: 3,
  [KEYS.manualReconciliationWindowDays]: 30,
  [KEYS.manualReconciliationUser7d]: 5,
  [KEYS.manualReconciliationMonthPct]: 30,
  [KEYS.historyMultiplier]: 3,
  [KEYS.outlierBlockMultiplier]: 10,
  [KEYS.newAccountThreshold]: 5000,
  [KEYS.bankAccountCooldownHours]: 48,
  [KEYS.duplicateWindowDays]: 90,
  [KEYS.newSupplierDays]: 30,
  [KEYS.newSupplierMinAmount]: 20000,
  [KEYS.frequentReversalUser30d]: 3,
  // DEC-007 diz 5; a regra que já existia disparava com 3 estornos na empresa em 30 dias. Falha segura: o padrão fica 3 (DI-DEC007-1).
  [KEYS.frequentReversalCompany30d]: 3,
  [KEYS.reconciliationAutoStrong]: false,
});

/**
 * Lê um parâmetro numérico do Financeiro com o padrão do catálogo. Valor gravado que não é número finito (linha corrompida, tipo trocado) vira o padrão:
 * nunca um NaN que faria a comparação dar "falso" e desligar o controle (falha segura da DEC-007).
 */
async function readFinanceNumber(key, tenant, transaction, fallback = FINANCE_SETTINGS_DEFAULTS[key]) {
  const { getSetting } = require('../../../../features/settings/settings.service'); // leitura tardia: o dicionário de parâmetros carrega este arquivo
  const value = Number(await getSetting(key, tenant, transaction, fallback));
  return Number.isFinite(value) ? value : Number(fallback);
}

module.exports = { KEYS, FINANCE_SETTINGS_SCHEMA, FINANCE_SETTINGS_DEFAULTS, readFinanceNumber };

require('./finance-setting-guards'); // depois do exports: a trava lê KEYS e readFinanceNumber deste arquivo
