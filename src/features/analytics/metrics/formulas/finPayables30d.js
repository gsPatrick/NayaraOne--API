'use strict';

/** M9-D621 — KPI fin.payables_30d: janela de 30 dias (hoje até hoje+29, cumulativa), próprio e pendente, em reais. Regra em _finWindow.js. */
const { windowFormula } = require('./_finWindow');

module.exports = windowFormula({ id: 'fin.payables_30d', windowDays: 30, caseAmounts: ['22000.00', '22000.00', '0.005', '0.01'] });
