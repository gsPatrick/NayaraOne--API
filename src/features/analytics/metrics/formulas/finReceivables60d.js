'use strict';

/** M9-D621 — KPI fin.receivables_60d: janela de 60 dias (hoje até hoje+59, cumulativa), próprio e pendente, em reais. Regra em _finWindow.js. */
const { windowFormula } = require('./_finWindow');

module.exports = windowFormula({ id: 'fin.receivables_60d', windowDays: 60, caseAmounts: ['112500.00', '112500.00', '0.015', '0.02'] });
