'use strict';

/**
 * Parâmetros do relatório semanal de saúde (Caderno M4 §19 "Recebíveis 7/30/60 dias — direitos previstos ponderados por
 * status"). O livro manda ponderar por status mas não diz os pesos: viram parâmetros do administrador (aba "Financeiro"
 * de Configurações), de 0 a 1, por status do recebível (DI-M4LR-2). Padrão = comportamento anterior do relatório: o que
 * está em dia e o saldo do parcialmente recebido contam inteiros (1) e o vencido não conta como entrada provável (0).
 */
const KEYS = Object.freeze({
  onTime: 'finance.relatorio.peso_recebivel_em_dia',
  partial: 'finance.relatorio.peso_recebivel_parcial',
  overdue: 'finance.relatorio.peso_recebivel_vencido',
});

const label = (text) => ({ type: 'number', min: 0, max: 1, label: text });

const FINANCE_HEALTH_REPORT_SETTINGS_SCHEMA = Object.freeze({
  [KEYS.onTime]: label('Peso do recebível em dia (0 a 1)'),
  [KEYS.partial]: label('Peso do saldo do recebível parcialmente recebido (0 a 1)'),
  [KEYS.overdue]: label('Peso do recebível vencido (0 a 1)'),
});

const FINANCE_HEALTH_REPORT_DEFAULTS = Object.freeze({ [KEYS.onTime]: 1, [KEYS.partial]: 1, [KEYS.overdue]: 0 });

/** Status do recebível para a ponderação: em dia (PENDING a vencer), parcial (PARTIALLY_SETTLED a vencer), vencido. */
const RECEIVABLE_WEIGHT_STATUSES = Object.freeze({ EM_DIA: KEYS.onTime, PARCIAL: KEYS.partial, VENCIDO: KEYS.overdue });

function validWeight(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/** Pesos gravados pela empresa (ou o padrão). Sem empresa no contexto, o padrão. */
async function readReceivableWeights(tenant, transaction) {
  const { getSetting } = require('../../../../features/settings/settings.service'); // leitura tardia: o dicionário de parâmetros carrega este arquivo
  const out = {};
  for (const [status, key] of Object.entries(RECEIVABLE_WEIGHT_STATUSES)) {
    const fallback = FINANCE_HEALTH_REPORT_DEFAULTS[key];
    out[status] = tenant && tenant.companyId ? validWeight(await getSetting(key, tenant, transaction, fallback), fallback) : fallback;
  }
  return out;
}

module.exports = { KEYS, FINANCE_HEALTH_REPORT_SETTINGS_SCHEMA, FINANCE_HEALTH_REPORT_DEFAULTS, RECEIVABLE_WEIGHT_STATUSES, readReceivableWeights };
