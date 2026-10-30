'use strict';

const { getSetting } = require('../../settings/settings.service');
const { parseDays } = require('./insurance.settings');

/** Padrões do livro e do parametros.csv (M9-D238): marcos 60, 30, 15 e 7 dias; cotação de renovação aos 30 dias; tarefa manual com 3 dias. */
const PADROES = Object.freeze({ renewalAlertDays: Object.freeze([60, 30, 15, 7]), renewalQuoteEnabled: true, renewalQuoteDays: 30, manualTaskDueDays: 3 });

const inteiro = (v, padrao, min) => (Number.isInteger(v) && v >= min ? v : padrao);

async function readInsuranceParams(ctx, transaction) {
  const [marcos, cotar, cotarDias, prazo] = await Promise.all([
    getSetting('integration.insurance.renewal_alert_days', ctx, transaction, PADROES.renewalAlertDays.join(',')),
    getSetting('integration.insurance.renewal_quote_enabled', ctx, transaction, PADROES.renewalQuoteEnabled),
    getSetting('integration.insurance.renewal_quote_days', ctx, transaction, PADROES.renewalQuoteDays),
    getSetting('integration.insurance.manual_task_due_days', ctx, transaction, PADROES.manualTaskDueDays),
  ]);
  return {
    renewalAlertDays: parseDays(String(marcos)) || [...PADROES.renewalAlertDays],
    renewalQuoteEnabled: cotar !== false,
    renewalQuoteDays: inteiro(cotarDias, PADROES.renewalQuoteDays, 1),
    manualTaskDueDays: inteiro(prazo, PADROES.manualTaskDueDays, 1),
  };
}

module.exports = { PADROES, readInsuranceParams };
