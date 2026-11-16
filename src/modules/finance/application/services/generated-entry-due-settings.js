'use strict';

/**
 * Vencimento das contas a pagar que o PRÓPRIO SISTEMA gera, sem ninguém informar data (decisão do Patrick, 16/11/2026):
 *  - medição de obra aprovada (consumidor measurement.approved, Marco 6 §7);
 *  - recebimento de materiais confirmado e o valor recalculado depois das divergências (Marco 7, "invoice match = payable");
 *  - ressarcimento ou desconto de garantia (Marco 6, pós-obra).
 * Essas contas nasciam sem vencimento: ficavam fora de "contas a pagar em 7/30 dias" e reprovavam a verificação de completude do vencimento
 * do BI (finance_health_due_date_completeness, M9-D697), travando os indicadores do Financeiro no Centro de Comando.
 *
 * Os cadernos (Marcos 4, 6, 7 e 9) não definem esse prazo; pela regra do projeto, o que o livro não resolve vira parâmetro do administrador
 * (aba Financeiro de Configurações). Padrão: 30 dias corridos a partir do fato (aprovação da medição, confirmação do recebimento, resolução da
 * garantia), contados no calendário de São Paulo; o vencimento é a DATA, gravada ao meio-dia de São Paulo como as demais datas puras do
 * sistema (utils/businessDate.js). 0 = vence no próprio dia do fato.
 */
const { startOfBusinessDay } = require('../../../../utils/businessDate');

const KEYS = Object.freeze({
  measurement: 'financeiro.vencimento.medicao_aprovada_dias',
  goodsReceipt: 'financeiro.vencimento.recebimento_compra_dias',
  warranty: 'financeiro.vencimento.resolucao_garantia_dias',
});

const DAYS = { type: 'integer', min: 0, max: 365 };

const GENERATED_DUE_SETTINGS_SCHEMA = Object.freeze({
  [KEYS.measurement]: DAYS,
  [KEYS.goodsReceipt]: DAYS,
  [KEYS.warranty]: DAYS,
});

const GENERATED_DUE_SETTINGS_DEFAULTS = Object.freeze({
  [KEYS.measurement]: 30,
  [KEYS.goodsReceipt]: 30,
  [KEYS.warranty]: 30,
});

const NOON_SAO_PAULO_MS = 12 * 3600 * 1000;

function getSettingLazy() {
  return require('../../../../features/settings/settings.service').getSetting; // leitura tardia: o dicionário de parâmetros carrega este arquivo
}

/** Dias do parâmetro; valor gravado fora de 0..365 ou não inteiro vira o padrão (falha segura). */
async function readDueDays(key, tenant, transaction) {
  const fallback = GENERATED_DUE_SETTINGS_DEFAULTS[key];
  const value = Number(await getSettingLazy()(key, tenant, transaction, fallback));
  return Number.isInteger(value) && value >= DAYS.min && value <= DAYS.max ? value : fallback;
}

/** Vencimento = dia do fato em São Paulo + N dias do parâmetro, ao meio-dia de São Paulo. */
async function generatedDueAt(key, tenant, factAt, transaction) {
  const days = await readDueDays(key, tenant, transaction);
  const base = factAt ? new Date(factAt) : new Date();
  return new Date(startOfBusinessDay(Number.isNaN(base.getTime()) ? new Date() : base, days).getTime() + NOON_SAO_PAULO_MS);
}

module.exports = { KEYS, GENERATED_DUE_SETTINGS_SCHEMA, GENERATED_DUE_SETTINGS_DEFAULTS, readDueDays, generatedDueAt };
