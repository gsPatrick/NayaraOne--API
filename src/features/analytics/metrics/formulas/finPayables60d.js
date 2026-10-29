'use strict';

/** M9-D621 — KPI fin.payables_60d: janela de 60 dias (hoje até hoje+59, cumulativa), próprio e pendente, em reais. Regra em _finWindow.js. */
const { windowFormula } = require('./_finWindow');

module.exports = windowFormula({ id: 'fin.payables_60d', windowDays: 60, caseAmounts: ['40500.00', '40500.00', '99.994', '99.99'] });
