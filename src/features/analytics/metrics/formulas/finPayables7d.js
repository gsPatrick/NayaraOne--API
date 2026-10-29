'use strict';

/** M9-D621 — KPI fin.payables_7d: janela de 7 dias (hoje até hoje+6, cumulativa), próprio e pendente, em reais. Regra em _finWindow.js. */
const { windowFormula } = require('./_finWindow');

module.exports = windowFormula({ id: 'fin.payables_7d', windowDays: 7, caseAmounts: ['15000.00', '15000.00', '1234.565', '1234.57'] });
