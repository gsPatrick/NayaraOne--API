'use strict';

const { getSetting } = require('../../../../../features/settings/settings.service');

/** Padrões (M9-D237): página de 100 linhas, 3 dias de tolerância, 2 minutos de idade mínima (o valor fixo que o job já tinha) e confirmar sem valor (o que o código já fazia). */
const PADROES = Object.freeze({ statementPageSize: 100, dateToleranceDays: 3, reconcileMinAgeMin: 2, confirmWithoutAmount: true });

const inteiro = (v, padrao, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : padrao);

async function readBankParams(ctx, transaction) {
  const [pagina, tolerancia, idade, semValor] = await Promise.all([
    getSetting('integration.bank.statement_page_size', ctx, transaction, PADROES.statementPageSize),
    getSetting('integration.bank.reconcile_date_tolerance_days', ctx, transaction, PADROES.dateToleranceDays),
    getSetting('integration.bank.reconcile_min_age_min', ctx, transaction, PADROES.reconcileMinAgeMin),
    getSetting('integration.bank.confirm_without_amount', ctx, transaction, PADROES.confirmWithoutAmount),
  ]);
  return {
    statementPageSize: inteiro(pagina, PADROES.statementPageSize, 10, 500),
    dateToleranceDays: inteiro(tolerancia, PADROES.dateToleranceDays, 0, 30),
    reconcileMinAgeMin: inteiro(idade, PADROES.reconcileMinAgeMin, 0, 1440),
    confirmWithoutAmount: semValor !== false,
  };
}

module.exports = { PADROES, readBankParams };
